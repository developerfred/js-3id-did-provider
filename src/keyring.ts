import { generateKeyPairFromSeed, KeyPair } from '@stablelib/x25519'
import { HDNode } from '@ethersproject/hdnode'
import { Wallet } from '@ethersproject/wallet'
import { EllipticSigner, Signer, Decrypter, x25519Decrypter, JWE } from 'did-jwt'

import { randomBytes, asymEncryptJWE, asymDecryptJWE } from './crypto'
import { encodeKey, hexToU8A, u8aToHex } from './utils'

export const LATEST = 'latest'
const BASE_PATH = "m/51073068'/0'"
const ROOT_STORE_PATH = "0'/0'/0'/0'/0'/0'/0'/0'"

// Using the long paths with base and rootstore is extremely slow.
// For auth simple paths are used instead.
const AUTH_PATH_WALLET = '0'
const AUTH_PATH_ASYM_ENCRYPTION = '2'

interface ThreeIdMetadata extends Record<string, any> {
  controllers: Array<string>
}

export interface ThreeIdState {
  metadata: ThreeIdMetadata
  content: Record<string, any> | null
  deterministic?: boolean
}

export interface KeySet {
  signing: Uint8Array
  management: Uint8Array
  encryption: Uint8Array
}

interface FullKeySet {
  seed: Uint8Array
  publicKeys: KeySet
  secretKeys: KeySet
  v03ID?: string
}

function deriveKeySet(seed: Uint8Array, v03ID?: string): FullKeySet {
  // TODO - dont' use ROOT_STORE_PATH unless when needed. Very expensive.
  let hdNode = HDNode.fromSeed(seed).derivePath(BASE_PATH)
  if (v03ID) hdNode = hdNode.derivePath(ROOT_STORE_PATH)
  const signing = hdNode.derivePath('0')
  const management = hdNode.derivePath('1')
  const encryption = generateKeyPairFromSeed(hexToU8A(hdNode.derivePath('2').privateKey.slice(2)))
  return {
    seed,
    publicKeys: {
      signing: hexToU8A(signing.publicKey.slice(2)),
      management: hexToU8A(management.publicKey.slice(2)),
      encryption: encryption.publicKey,
    },
    secretKeys: {
      signing: hexToU8A(signing.privateKey.slice(2)),
      management: hexToU8A(management.privateKey.slice(2)),
      encryption: encryption.secretKey,
    },
    v03ID,
  }
}

export default class Keyring {
  // map from 3ID version to key set
  protected _keySets: Record<string, FullKeySet> = {}
  // map from kid to encryption key
  protected _versionMap: Record<string, string> = {}
  // encrypted old seeds
  protected _pastSeeds: Array<JWE> = []
  // v03ID if legacy 3ID
  protected _v03ID?: string

  constructor(seed?: Uint8Array, v03ID?: string) {
    if (!seed) {
      seed = randomBytes(32)
    }
    if (v03ID) this._v03ID = v03ID
    this._keySets[LATEST] = deriveKeySet(seed, v03ID)
    let encKid = encodeKey(this._keySets[LATEST].publicKeys.encryption, 'x25519').slice(-15)
    this._versionMap[encKid] = LATEST
    encKid = encodeKey(this._keySets[LATEST].publicKeys.management, 'secp256k1')
    this._versionMap[encKid] = LATEST
  }

  get v03ID(): string | undefined {
    return this._v03ID
  }

  get seed(): Uint8Array {
    return this._keySets[LATEST].seed
  }

  get pastSeeds(): Array<JWE> {
    return this._pastSeeds
  }

  async loadPastSeeds(pastSeeds: Array<JWE>): Promise<void> {
    // Store a copy of the pastSeeds
    this._pastSeeds = [...pastSeeds]
    // Decrypt each version with the version that came after it
    let version: string = LATEST
    let jwe = pastSeeds.pop()
    while (jwe) {
      const decrypted = await asymDecryptJWE(jwe, { decrypter: this.getAsymDecrypter([], version) })
      if (decrypted.v03ID) {
        this._v03ID = decrypted.v03ID as string
        delete decrypted.v03ID
      }
      version = Object.keys(decrypted)[0]
      this._keySets[version] = deriveKeySet(new Uint8Array(decrypted[version]), this._v03ID)
      this._updateVersionMap(version, this._keySets[version])
      jwe = pastSeeds.pop()
    }
  }

  _updateVersionMap(version: string, keySet: FullKeySet): void {
    let encKid = encodeKey(keySet.publicKeys.encryption, 'x25519').slice(-15)
    this._versionMap[encKid] = version
    encKid = encodeKey(keySet.publicKeys.management, 'secp256k1')
    this._versionMap[encKid] = version
  }

  async generateNewKeys(prevVersion: string): Promise<void> {
    if (this._keySets[prevVersion]) throw new Error('Key set version already exist')
    // Map encryption kid, mgmt pub, and key set to prevVersion
    this._updateVersionMap(prevVersion, this._keySets[LATEST])
    // Store previous key set
    this._keySets[prevVersion] = this._keySets[LATEST]
    // Generate a new seed and derive key set
    this._keySets[LATEST] = deriveKeySet(randomBytes(32))
    // Add encryption kid and mgmt pub to map
    this._updateVersionMap(LATEST, this._keySets[LATEST])
    // Encrypt the previous seed to the new seed
    const cleartext: Record<string, any> = { [prevVersion]: this._keySets[prevVersion].seed }
    if (this._keySets[prevVersion].v03ID) cleartext.v03ID = this._keySets[prevVersion].v03ID
    this._pastSeeds.push(
      await asymEncryptJWE(cleartext, { publicKey: this.getEncryptionPublicKey() })
    )
  }

  getAsymDecrypter(fragments: Array<string> = [], version?: string): Decrypter {
    if (!version) {
      const fragmentWithKey = fragments.find((fragment: string) => this._versionMap[fragment])
      version = fragmentWithKey ? this._versionMap[fragmentWithKey] : LATEST
    }
    const key = this._keySets[version].secretKeys.encryption
    return x25519Decrypter(key)
  }

  getSigner(version: string = LATEST): Signer {
    // If we get an unknown version it's the latest
    // since we only store the version after a key rotation.
    const keyset = this._keySets[version] || this._keySets[LATEST]
    return EllipticSigner(u8aToHex(keyset.secretKeys.signing))
  }

  getKeyFragment(version: string = LATEST, encKey = false): string {
    // If we get an unknown version it's the latest
    // since we only store the version after a key rotation.
    const keyset = this._keySets[version] || this._keySets[LATEST]
    if (encKey) {
      return encodeKey(keyset.publicKeys.encryption, 'x25519').slice(-15)
    }
    return encodeKey(keyset.publicKeys.signing, 'secp256k1').slice(-15)
  }

  getMgmtSigner(pubKey: string): Signer {
    const keyset = this._keySets[this._versionMap[pubKey]].secretKeys
    if (!keyset) throw new Error(`Key not found: ${pubKey}`)
    return EllipticSigner(u8aToHex(keyset.management))
  }

  getEncryptionPublicKey(): Uint8Array {
    return this._keySets[LATEST].publicKeys.encryption
  }

  get3idState(genesis?: boolean): ThreeIdState {
    const keys = this._keySets[LATEST].publicKeys
    const signing = encodeKey(keys.signing, 'secp256k1')
    const encryption = encodeKey(keys.encryption, 'x25519')
    // use the last 12 chars as key id
    const state: ThreeIdState = {
      metadata: { controllers: [`did:key:${encodeKey(keys.management, 'secp256k1')}`] },
      content: {
        publicKeys: {
          [signing.slice(-15)]: signing,
          [encryption.slice(-15)]: encryption,
        },
      },
    }
    if (genesis) {
      state.metadata.family = '3id'
      state.deterministic = true
    }
    if (this._keySets[LATEST].v03ID) {
      state.content = null
      state.metadata.controllers = [`did:key:${signing}`]
    }
    return state
  }

  static authSecretToKeyPair(authSecret: Uint8Array): KeyPair {
    const node = HDNode.fromSeed(authSecret).derivePath(AUTH_PATH_ASYM_ENCRYPTION)
    return generateKeyPairFromSeed(hexToU8A(node.privateKey.slice(2)))
  }

  static authSecretToWallet(authSecret: Uint8Array): Wallet {
    const node = HDNode.fromSeed(authSecret).derivePath(AUTH_PATH_WALLET)
    return new Wallet(node.privateKey)
  }
}

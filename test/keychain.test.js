import { validateLink } from '3id-blockchain-utils'
import * as u8a from 'uint8arrays'

import { Keychain, newAuthEntry } from '../src/keychain'
import Keyring from '../src/keyring'
import {
  AsymEncryptedMessage,
  asymDecrypt,
  asymEncrypt,
  randomBytes,
} from '../src/crypto'

const seed = u8a.fromString('8e641c0dc77f6916cc7f743dad774cdf9f6f7bcb880b11395149dd878377cd398650bbfd4607962b49953c87da4d7f3ff247ed734b06f96bdd69479377bc612b', 'base16')
const randomAuthSecret = () => randomBytes(32)
const randomSecret = () => '0x' + Buffer.from(randomBytes(32)).toString('hex')

describe('Keychain', () => {
  let keyring, threeIdx

  beforeAll(() => {
    keyring = new Keyring(seed)
  })

  beforeEach(async () => {
    let authEntries = []
    threeIdx = {
      id: 'did:3:asdf',
      addAuthEntry: jest.fn(),
      loadIDX: jest.fn(async () => null),
      setDIDProvider: jest.fn(),
      create3idDoc: jest.fn(),
      createIDX: jest.fn(async entry => authEntries.push(entry)),
      addAuthEntries: jest.fn(async entries => authEntries = authEntries.concat(entries)),
      getAllAuthEntries: jest.fn(() => authEntries),
      get3idVersion: jest.fn(async () => '0'),
      rotateKeys: jest.fn(),
      setV03ID: jest.fn()
    }
  })

  it('Create with v03ID', async () => {
    const v03ID = 'did:3:abc234'
    const keychain = await Keychain.create(threeIdx, () => {}, randomAuthSecret(), v03ID)
    expect(threeIdx.setDIDProvider).toHaveBeenCalledTimes(1)
    expect(threeIdx.create3idDoc).toHaveBeenCalledTimes(1)
    expect(threeIdx.setV03ID).toHaveBeenCalledTimes(1)
    expect(threeIdx.setV03ID).toHaveBeenCalledWith(v03ID)
    expect(await keychain.list()).toEqual([])
    expect(keychain._keyring.v03ID).toEqual(v03ID)
  })

  it('load, no IDX present', async () => {
    const keychain = await Keychain.load(threeIdx, randomAuthSecret(), () => {})
    expect(threeIdx.loadIDX).toHaveBeenCalledTimes(1)
    expect(threeIdx.setDIDProvider).toHaveBeenCalledTimes(1)
    expect(threeIdx.create3idDoc).toHaveBeenCalledTimes(1)
    expect(threeIdx.setV03ID).toHaveBeenCalledTimes(0)
    expect(await keychain.list()).toEqual([])
  })

  it('load, IDX present', async () => {
    const authSecret = randomAuthSecret()
    // add the auth entry to IDX
    const tmpKc = await Keychain.load(threeIdx, authSecret, () => {})
    threeIdx.createIDX(await newAuthEntry(tmpKc._keyring, threeIdx.id, 'authid', authSecret))

    threeIdx.loadIDX = jest.fn(async () => ({
      seed: threeIdx.getAllAuthEntries()[0].data,
      pastSeeds: []
    }))
    const keychain = await Keychain.load(threeIdx, authSecret, () => {})
    expect(threeIdx.loadIDX).toHaveBeenCalledTimes(1)
    expect(await keychain.list()).toEqual(['authid'])
  })

  it('load, IDX present, v03ID', async () => {
    const v03ID = 'did:3:abc234'
    const authSecret = randomAuthSecret()
    const keychain = await Keychain.create(threeIdx, () => {}, randomAuthSecret(), v03ID)
    expect(threeIdx.setV03ID).toHaveBeenCalledTimes(1)
    await keychain.add('auth1', authSecret)
    await keychain.commit()

    threeIdx.loadIDX = jest.fn(async () => ({
      seed: threeIdx.getAllAuthEntries()[0].data,
      pastSeeds: keychain._keyring.pastSeeds
    }))
    const keychain1 = await Keychain.load(threeIdx, authSecret, () => {})
    expect(threeIdx.setV03ID).toHaveBeenCalledTimes(2)
    expect(threeIdx.setV03ID).toHaveBeenNthCalledWith(2, v03ID)
    expect(keychain1._keyring.v03ID).toEqual(v03ID)
  })

  it('commit adds, no IDX created yet', async () => {
    const keychain = new Keychain(keyring, threeIdx)
    expect(threeIdx.createIDX).toHaveBeenCalledTimes(0)
    await keychain.add('auth1', randomAuthSecret())
    await keychain.add('auth2', randomAuthSecret())
    expect(await keychain.list()).toEqual([])
    await keychain.commit()
    expect(threeIdx.createIDX).toHaveBeenCalledTimes(1)
    expect(threeIdx.addAuthEntries).toHaveBeenCalledTimes(1)
    expect(threeIdx.addAuthEntries).toHaveBeenCalledTimes(1)
    expect(await keychain.list()).toEqual(['auth2', 'auth1'])
  })

  it('commit adds, IDX already created', async () => {
    const keychain = new Keychain(keyring, threeIdx)
    threeIdx.createIDX(await newAuthEntry(keychain._keyring, threeIdx.id, 'authid', randomAuthSecret()))

    await keychain.add('auth1', randomAuthSecret())
    await keychain.add('auth2', randomAuthSecret())
    expect(await keychain.list()).toEqual(['authid'])
    await keychain.commit()
    expect(threeIdx.createIDX).toHaveBeenCalledTimes(1)
    expect(threeIdx.addAuthEntries).toHaveBeenCalledTimes(1)
    expect(await keychain.list()).toEqual(['authid', 'auth1', 'auth2'])
  })

  it('commit removes', async () => {
    const authSecret0 = randomAuthSecret()
    const authSecret1 = randomAuthSecret()
    const keychain = new Keychain(keyring, threeIdx)
    threeIdx.createIDX(await newAuthEntry(keychain._keyring, threeIdx.id, 'authid', authSecret0))
    await keychain.add('auth1', authSecret1)
    await keychain.commit()

    // rotate
    await keychain.remove('authid')
    expect(await keychain.list()).toEqual(['authid', 'auth1'])
    await keychain.commit()
    threeIdx.loadIDX = jest.fn(async () => ({
      seed: threeIdx.rotateKeys.mock.calls[0][2][0].data,
      pastSeeds: threeIdx.rotateKeys.mock.calls[0][1],
    }))
    // load with auth1
    const keychain1 = await Keychain.load(threeIdx, authSecret1, () => {})
    // failt to load with authid
    await expect(Keychain.load(threeIdx, authSecret0, () => {})).rejects.toThrow('Auth not allowed')
  })

  it('add updates status', async () => {
    const keychain = await Keychain.load(threeIdx, randomAuthSecret(), () => {})
    expect(keychain.status()).toEqual({ clean: true, adding: [], removing: [] })
    await keychain.add('auth1', randomAuthSecret())
    await keychain.add('auth2', randomAuthSecret())
    expect(keychain.status()).toEqual({
      clean: false,
      adding: ['auth1', 'auth2'],
      removing: [],
    })
    await keychain.add('auth3', randomAuthSecret())
    expect(keychain.status()).toEqual({
      clean: false,
      adding: ['auth1', 'auth2', 'auth3'],
      removing: [],
    })
  })

  it('remove updates status', async () => {
    const keychain = await Keychain.load(threeIdx, randomAuthSecret(), () => {})
    expect(keychain.status()).toEqual({ clean: true, adding: [], removing: [] })
    await keychain.remove('auth1', randomAuthSecret())
    await keychain.remove('auth2', randomAuthSecret())
    expect(keychain.status()).toEqual({
      clean: false,
      adding: [],
      removing: ['auth1', 'auth2'],
    })
    await keychain.remove('auth3', randomAuthSecret())
    expect(keychain.status()).toEqual({
      clean: false,
      adding: [],
      removing: ['auth1', 'auth2', 'auth3'],
    })
  })
})

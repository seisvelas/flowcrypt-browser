/* ©️ 2016 - present FlowCrypt a.s. Limitations apply. Contact human@flowcrypt.com */

'use strict';

import { Buf } from './buf.js';
import { Catch } from '../platform/catch.js';
import { MsgBlockParser } from './msg-block-parser.js';
import { PgpArmor } from './pgp-armor.js';
import { opgp } from './pgp.js';
import { KeyCache } from '../platform/key-cache.js';

export type Contact = {
  email: string;
  name: string | null;
  pubkey: string | null;
  has_pgp: 0 | 1;
  searchable: string[];
  client: string | null;
  fingerprint: string | null;
  longid: string | null;
  longids: string[];
  pending_lookup: number;
  last_use: number | null;
  pubkey_last_sig: number | null;
  pubkey_last_check: number | null;
  expiresOn: number | null;
};

export interface PrvKeyInfo {
  private: string;
  longid: string;
  passphrase?: string;
  decrypted?: OpenPGP.key.Key;  // only for internal use in this file
  parsed?: OpenPGP.key.Key;     // only for internal use in this file
}

export type KeyAlgo = 'curve25519' | 'rsa2048' | 'rsa4096';

export interface KeyInfo extends PrvKeyInfo {
  public: string;
  fingerprint: string;
  primary: boolean;
}

type KeyDetails$ids = {
  shortid: string;
  longid: string;
  fingerprint: string;
};

export interface KeyDetails {
  private?: string;
  public: string;
  isFullyEncrypted: boolean | undefined;
  isFullyDecrypted: boolean | undefined;
  ids: KeyDetails$ids[];
  users: string[];
  created: number;
  algo: { // same as OpenPGP.key.AlgorithmInfo
    algorithm: string;
    algorithmId: number;
    bits?: number;
    curve?: string;
  };
}
export type PrvPacket = (OpenPGP.packet.SecretKey | OpenPGP.packet.SecretSubkey);

export class PgpKey {

  public static create = async (
    userIds: { name: string, email: string }[], variant: KeyAlgo, passphrase: string, expireInMonths: number | undefined
  ): Promise<{ private: string, public: string }> => {
    const opt: OpenPGP.KeyOptions = { userIds, passphrase };
    if (variant === 'curve25519') {
      opt.curve = 'curve25519';
    } else if (variant === 'rsa2048') {
      opt.numBits = 2048;
    } else {
      opt.numBits = 4096;
    }
    if (expireInMonths) {
      opt.keyExpirationTime = 60 * 60 * 24 * 30 * expireInMonths; // seconds from now
    }
    const k = await opgp.generateKey(opt);
    return { public: k.publicKeyArmored, private: k.privateKeyArmored };
  }

  /**
   * used only for keys that we ourselves parsed / formatted before, eg from local storage, because no err handling
   */
  public static read = async (armoredKey: string) => { // should be renamed to readOne
    const fromCache = KeyCache.getArmored(armoredKey);
    if (fromCache) {
      return fromCache;
    }
    const { keys: [key] } = await opgp.key.readArmored(armoredKey);
    if (key?.isPrivate()) {
      KeyCache.setArmored(armoredKey, key);
    }
    return key;
  }

  /**
   * Read many keys, could be armored or binary, in single armor or separately, useful for importing keychains of various formats
   */
  public static readMany = async (fileData: Buf): Promise<{ keys: OpenPGP.key.Key[], errs: Error[] }> => {
    const allKeys: OpenPGP.key.Key[] = [];
    const allErrs: Error[] = [];
    const { blocks } = MsgBlockParser.detectBlocks(fileData.toUtfStr('ignore'));
    const armoredPublicKeyBlocks = blocks.filter(block => block.type === 'publicKey' || block.type === 'privateKey');
    const pushKeysAndErrs = async (content: string | Buf, isArmored: boolean) => {
      try {
        const { err, keys } = isArmored
          ? await opgp.key.readArmored(content.toString())
          : await opgp.key.read(typeof content === 'string' ? Buf.fromUtfStr(content) : content);
        allErrs.push(...(err || []));
        allKeys.push(...keys);
      } catch (e) {
        allErrs.push(e instanceof Error ? e : new Error(String(e)));
      }
    };
    if (armoredPublicKeyBlocks.length) {
      for (const block of blocks) {
        await pushKeysAndErrs(block.content, true);
      }
    } else {
      await pushKeysAndErrs(fileData, false);
    }
    return { keys: allKeys, errs: allErrs };
  }

  public static isPacketPrivate = (p: OpenPGP.packet.AnyKeyPacket): p is PrvPacket => {
    return p.tag === opgp.enums.packet.secretKey || p.tag === opgp.enums.packet.secretSubkey;
  }

  public static decrypt = async (prv: OpenPGP.key.Key, passphrase: string, optionalKeyid?: OpenPGP.Keyid, optionalBehaviorFlag?: 'OK-IF-ALREADY-DECRYPTED'): Promise<boolean> => {
    if (!prv.isPrivate()) {
      throw new Error("Nothing to decrypt in a public key");
    }
    const chosenPrvPackets = prv.getKeys(optionalKeyid).map(k => k.keyPacket).filter(PgpKey.isPacketPrivate) as PrvPacket[];
    if (!chosenPrvPackets.length) {
      throw new Error(`No private key packets selected of ${prv.getKeys().map(k => k.keyPacket).filter(PgpKey.isPacketPrivate).length} prv packets available`);
    }
    for (const prvPacket of chosenPrvPackets) {
      if (prvPacket.isDecrypted()) {
        if (optionalBehaviorFlag === 'OK-IF-ALREADY-DECRYPTED') {
          continue;
        } else {
          throw new Error("Decryption failed - key packet was already decrypted");
        }
      }
      try {
        await prvPacket.decrypt(passphrase); // throws on password mismatch
      } catch (e) {
        if (e instanceof Error && e.message.toLowerCase().includes('incorrect key passphrase')) {
          return false;
        }
        throw e;
      }
    }
    return true;
  }

  public static encrypt = async (prv: OpenPGP.key.Key, passphrase: string) => {
    if (!passphrase || passphrase === 'undefined' || passphrase === 'null') {
      throw new Error(`Encryption passphrase should not be empty:${typeof passphrase}:${passphrase}`);
    }
    const secretPackets = prv.getKeys().map(k => k.keyPacket).filter(PgpKey.isPacketPrivate);
    const encryptedPacketCount = secretPackets.filter(p => !p.isDecrypted()).length;
    if (!secretPackets.length) {
      throw new Error(`No private key packets in key to encrypt. Is this a private key?`);
    }
    if (encryptedPacketCount) {
      throw new Error(`Cannot encrypt a key that has ${encryptedPacketCount} of ${secretPackets.length} private packets still encrypted`);
    }
    await prv.encrypt(passphrase);
    if (!prv.isFullyEncrypted()) {
      throw new Error('Expected key to be fully encrypted after prv.encrypt');
    }
  }

  public static normalize = async (armored: string): Promise<{ normalized: string, keys: OpenPGP.key.Key[] }> => {
    try {
      let keys: OpenPGP.key.Key[] = [];
      armored = PgpArmor.normalize(armored, 'key');
      if (RegExp(PgpArmor.headers('publicKey', 're').begin).test(armored)) {
        keys = (await opgp.key.readArmored(armored)).keys;
      } else if (RegExp(PgpArmor.headers('privateKey', 're').begin).test(armored)) {
        keys = (await opgp.key.readArmored(armored)).keys;
      } else if (RegExp(PgpArmor.headers('encryptedMsg', 're').begin).test(armored)) {
        keys = [new opgp.key.Key((await opgp.message.readArmored(armored)).packets)];
      }
      for (const k of keys) {
        for (const u of k.users) {
          u.otherCertifications = []; // prevent key bloat
        }
      }
      return { normalized: keys.map(k => k.armor()).join('\n'), keys };
    } catch (error) {
      Catch.reportErr(error);
      return { normalized: '', keys: [] };
    }
  }

  public static fingerprint = async (key: OpenPGP.key.Key | string): Promise<string | undefined> => {
    if (!key) {
      return undefined;
    } else if (key instanceof opgp.key.Key) {
      if (!key.primaryKey.getFingerprintBytes()) {
        return undefined;
      }
      try {
        return key.primaryKey.getFingerprint().toUpperCase();
      } catch (e) {
        console.error(e);
        return undefined;
      }
    } else {
      if (/^[0-9A-F]{40}$/.test(key)) {
        return key;
      }
      try {
        return await PgpKey.fingerprint(await PgpKey.read(key));
      } catch (e) {
        if (e instanceof Error && e.message === 'openpgp is not defined') {
          Catch.reportErr(e);
        }
        console.error(e);
        return undefined;
      }
    }
  }

  public static longid = async (keyOrFingerprintOrBytesOrLongid: string | OpenPGP.key.Key | undefined): Promise<string | undefined> => {
    if (!keyOrFingerprintOrBytesOrLongid) {
      return undefined;
    } else if (typeof keyOrFingerprintOrBytesOrLongid === 'string' && keyOrFingerprintOrBytesOrLongid.length === 8) {
      return opgp.util.str_to_hex(keyOrFingerprintOrBytesOrLongid).toUpperCase(); // in binary form
    } else if (typeof keyOrFingerprintOrBytesOrLongid === 'string' && keyOrFingerprintOrBytesOrLongid.length === 16) {
      return keyOrFingerprintOrBytesOrLongid.toUpperCase(); // already a longid
    } else if (typeof keyOrFingerprintOrBytesOrLongid === 'string' && keyOrFingerprintOrBytesOrLongid.length === 40) {
      return keyOrFingerprintOrBytesOrLongid.substr(-16); // was a fingerprint
    } else if (typeof keyOrFingerprintOrBytesOrLongid === 'string' && keyOrFingerprintOrBytesOrLongid.length === 49) {
      return keyOrFingerprintOrBytesOrLongid.replace(/ /g, '').substr(-16); // spaced fingerprint
    }
    return await PgpKey.longid(await PgpKey.fingerprint(keyOrFingerprintOrBytesOrLongid));
  }

  public static longids = async (keyIds: OpenPGP.Keyid[]) => {
    const longids: string[] = [];
    for (const id of keyIds) {
      const longid = await PgpKey.longid(id.bytes);
      if (longid) {
        longids.push(longid);
      }
    }
    return longids;
  }

  public static usableForEncryption = async (armored: string) => { // is pubkey usable for encrytion?
    if (! await PgpKey.longid(armored)) {
      return false;
    }
    const { keys: [pubkey] } = await opgp.key.readArmored(armored);
    if (!pubkey) {
      return false;
    }
    if (! await Catch.doesReject(pubkey.getEncryptionKey())) {
      return true; // good key - cannot be expired
    }
    return await PgpKey.usableButExpired(pubkey);
  }

  public static expired = async (key: OpenPGP.key.Key): Promise<boolean> => {
    if (!key) {
      return false;
    }
    const exp = await key.getExpirationTime('encrypt');
    if (exp === Infinity || !exp) {
      return false;
    }
    if (exp instanceof Date) {
      return Date.now() > exp.getTime();
    }
    throw new Error(`Got unexpected value for expiration: ${exp}`); // exp must be either null, Infinity or a Date
  }

  public static usableButExpired = async (key: OpenPGP.key.Key): Promise<boolean> => {
    if (!key) {
      return false;
    }
    if (! await Catch.doesReject(key.getEncryptionKey())) {
      return false; // good key - cannot be expired
    }
    const oneSecondBeforeExpiration = await PgpKey.dateBeforeExpirationIfAlreadyExpired(key);
    if (typeof oneSecondBeforeExpiration === 'undefined') {
      return false; // key does not expire
    }
    try { // try to see if the key was usable just before expiration
      await key.getEncryptionKey(undefined, oneSecondBeforeExpiration);
      return true;
    } catch (e) {
      console.log(e);
      return false;
    }
  }

  public static dateBeforeExpirationIfAlreadyExpired = async (key: OpenPGP.key.Key): Promise<Date | undefined> => {
    const expiration = await PgpKey.expiration(key, 'encrypt');
    return expiration && await PgpKey.expired(key) ? new Date(expiration.getTime() - 1000) : undefined;
  }

  public static expiration = async (key: OpenPGP.key.Key, capability: 'encrypt' | 'encrypt_sign' | 'sign' = 'encrypt') => {
    const expires = await key.getExpirationTime(capability); // returns Date or Infinity
    return expires instanceof Date ? expires : undefined;
  }

  public static parseDetails = async (armored: string): Promise<{ original: string, normalized: string, keys: KeyDetails[] }> => {
    const { normalized, keys } = await PgpKey.normalize(armored);
    return { original: armored, normalized, keys: await Promise.all(keys.map(PgpKey.details)) };
  }

  public static details = async (k: OpenPGP.key.Key): Promise<KeyDetails> => {
    const keys = k.getKeys();
    const algoInfo = k.primaryKey.getAlgorithmInfo();
    const algo = { algorithm: algoInfo.algorithm, bits: algoInfo.bits, curve: (algoInfo as any).curve, algorithmId: opgp.enums.publicKey[algoInfo.algorithm] };
    const created = k.primaryKey.created.getTime() / 1000;
    const ids: KeyDetails$ids[] = [];
    for (const key of keys) {
      const fingerprint = key.getFingerprint().toUpperCase();
      if (fingerprint) {
        const longid = await PgpKey.longid(fingerprint);
        if (longid) {
          const shortid = longid.substr(-8);
          ids.push({ fingerprint, longid, shortid });
        }
      }
    }
    return {
      private: k.isPrivate() ? k.armor() : undefined,
      isFullyDecrypted: k.isPrivate() ? k.isFullyDecrypted() : undefined,
      isFullyEncrypted: k.isPrivate() ? k.isFullyEncrypted() : undefined,
      public: k.toPublic().armor(),
      users: k.getUserIds(),
      ids,
      algo,
      created,
    };
  }

  /**
   * Get latest self-signature date, in utc millis.
   * This is used to figure out how recently was key updated, and if one key is newer than other.
   */
  public static lastSig = async (key: OpenPGP.key.Key): Promise<number> => {
    await key.getExpirationTime(); // will force all sigs to be verified
    const allSignatures: OpenPGP.packet.Signature[] = [];
    for (const user of key.users) {
      allSignatures.push(...user.selfCertifications);
    }
    for (const subKey of key.subKeys) {
      allSignatures.push(...subKey.bindingSignatures);
    }
    allSignatures.sort((a, b) => b.created.getTime() - a.created.getTime());
    const newestSig = allSignatures.find(sig => sig.verified === true);
    if (newestSig) {
      return newestSig.created.getTime();
    }
    throw new Error('No valid signature found in key');
  }

  public static revoke = async (key: OpenPGP.key.Key): Promise<string | undefined> => {
    if (! await key.isRevoked()) {
      key = await key.revoke({});
    }
    const certificate = await key.getRevocationCertificate();
    if (!certificate) {
      return undefined;
    } else if (typeof certificate === 'string') {
      return certificate;
    } else {
      return await opgp.stream.readToEnd(certificate);
    }
  }
}

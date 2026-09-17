import { utils } from 'ssh2';

/** Valid fixture input even with ssh2 1.17's occasional zero-truncating key generator. */
export function fixtureEd25519Pair(options: utils.KeyPairOptions = {}): utils.KeyPairReturn {
  for (let attempt = 0; attempt < 8; attempt++) {
    const pair = utils.generateKeyPairSync('ed25519', options);
    const phrase = 'passphrase' in options ? options.passphrase : undefined;
    const privateKey = utils.parseKey(pair.private, phrase), publicKey = utils.parseKey(pair.public);
    if (!(privateKey instanceof Error) && !(publicKey instanceof Error)
      && privateKey.isPrivateKey() && !publicKey.isPrivateKey() && privateKey.getPublicSSH().equals(publicKey.getPublicSSH())) return pair;
  }
  throw new Error('Could not generate a valid isolated Ed25519 fixture');
}

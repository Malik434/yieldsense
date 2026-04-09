import { decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';

// Paste your worker address here
const ss58Address = "5HPzp3e5TVJt8J81nrn28zvb8gh7ibS5DP1kaKjyiREUPH4y";

try {
    // 1. Decode SS58 to get the 32-byte Public Key
    const publicKeyBytes = decodeAddress(ss58Address);
    const publicKeyHex = u8aToHex(publicKeyBytes);
    
    // 2. The EVM address is the first 20 bytes (40 characters + 0x)
    const evmAddress = "0x" + publicKeyHex.slice(2, 42);

    console.log(`SS58 Address: ${ss58Address}`);
    console.log(`Public Key:   ${publicKeyHex}`);
    console.log(`EVM Address:  ${evmAddress}`);
} catch (error) {
    console.error("Invalid SS58 address format.");
}
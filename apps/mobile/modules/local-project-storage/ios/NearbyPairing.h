#import <Foundation/Foundation.h>
// Nearby pairing v1 (MAC-5; @scan-to-make/contracts/nearby-pairing and its test vector
// fixtures/nearby-pairing-v1.json). The phone finds the Mac over Bonjour, both screens
// show the same 6-digit code, and the user clicks Allow on the Mac.

// SHA-256("scantomake nearby v1 commit" || 0x00 || key): what the phone sends before it sees the nonce.
FOUNDATION_EXPORT NSData *STMNearbyCommit(NSData *key);
// The 6 digits from SHA-256("scantomake nearby v1 code" || 0x00 || S || key || nonce): its first
// 8 bytes, big-endian, mod 1,000,000. S is the SHA-256 of the SubjectPublicKeyInfo this phone saw.
FOUNDATION_EXPORT NSString *STMNearbyCode(NSData *publicKeySha256, NSData *key, NSData *nonce);
FOUNDATION_EXPORT NSString *STMBase64URL(NSData *data);
// Exactly 32 bytes from canonical unpadded base64url, or nil.
FOUNDATION_EXPORT NSData *STMNearbyBytes(id text);
// Trust on first use, for one nearby session only: the first certificate seen on base's
// host and port fixes S; after that only that public key is accepted. Returns the S of
// the presented key when it is accepted, or nil to refuse the connection.
FOUNDATION_EXPORT NSData *STMNearbyTrust(NSURLAuthenticationChallenge *challenge, NSURL *base, NSData *seen);

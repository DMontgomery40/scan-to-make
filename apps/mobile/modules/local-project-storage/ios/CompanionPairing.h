#import <Foundation/Foundation.h>
// Credentials stay native. Metadata returned to JavaScript never contains a token.
FOUNDATION_EXPORT NSDictionary *STMReadPairing(NSError **error);
FOUNDATION_EXPORT NSDictionary *STMPairingMetadata(NSDictionary *record);
FOUNDATION_EXPORT NSURL *STMCompanionBaseURL(NSString *value);
// A companion pinned by its certificate's SHA-256 may use any HTTPS host and port.
FOUNDATION_EXPORT NSURL *STMPinnedBaseURL(NSString *value, NSString *pin);
// The base URL for a pairing record, pinned or not.
FOUNDATION_EXPORT NSURL *STMPairingBaseURL(NSDictionary *record);
// Pairing link v2 addresses: 1-8 distinct pinnable origins, or nil.
FOUNDATION_EXPORT NSArray<NSString *> *STMPinnedAddresses(id value, NSString *pin);
// The addresses to try for a record: its activeUrl (last good) or baseUrl, then the rest in order.
FOUNDATION_EXPORT NSArray<NSString *> *STMAttemptOrder(NSDictionary *record);
// YES for failures that say nothing about the companion (unreachable, timeout, another server).
FOUNDATION_EXPORT BOOL STMTryNextAddress(NSString *failure);
// The SubjectPublicKeyInfo bytes of a DER certificate, or nil if it cannot be read.
FOUNDATION_EXPORT NSData *STMSubjectPublicKeyInfo(NSData *der);
// Answers a TLS challenge for a pinned record: only its exact certificate (certificateSha256)
// or public key (publicKeySha256, the SHA-256 of its SubjectPublicKeyInfo), on its host and
// port, is trusted. Unpinned records keep system trust. Returns YES when the server
// presented a different certificate or key and the connection was refused.
FOUNDATION_EXPORT BOOL STMPinnedTrust(NSURLAuthenticationChallenge *challenge, NSDictionary *record,
  void (^done)(NSURLSessionAuthChallengeDisposition, NSURLCredential *));
FOUNDATION_EXPORT BOOL STMFixtureURL(NSURL *url);
FOUNDATION_EXPORT NSString *STMTransportError(NSError *error);
FOUNDATION_EXPORT NSString * const STMPairingChanged;
// The same pairing: same Mac, device, token, protocol and pin (certificate, or public key
// and address list for v2; which listed address answers last does not matter). A
// renewed expiry (POST /v1/auth/refresh) or scope list is still the same one,
// so requests in flight carry on.
FOUNDATION_EXPORT BOOL STMSamePairing(NSDictionary *a, NSDictionary *b);

#import <Foundation/Foundation.h>
// Credentials stay native. Metadata returned to JavaScript never contains a token.
FOUNDATION_EXPORT NSDictionary *STMReadPairing(NSError **error);
FOUNDATION_EXPORT NSDictionary *STMPairingMetadata(NSDictionary *record);
FOUNDATION_EXPORT NSURL *STMCompanionBaseURL(NSString *value);
// A companion pinned by its certificate's SHA-256 may use any HTTPS host and port.
FOUNDATION_EXPORT NSURL *STMPinnedBaseURL(NSString *value, NSString *pin);
// The base URL for a pairing record, pinned or not.
FOUNDATION_EXPORT NSURL *STMPairingBaseURL(NSDictionary *record);
// Answers a TLS challenge for a pinned record: only its exact certificate, on its
// host and port, is trusted. Unpinned records keep system trust. Returns YES when
// the server presented a different certificate and the connection was refused.
FOUNDATION_EXPORT BOOL STMPinnedTrust(NSURLAuthenticationChallenge *challenge, NSDictionary *record,
  void (^done)(NSURLSessionAuthChallengeDisposition, NSURLCredential *));
FOUNDATION_EXPORT BOOL STMFixtureURL(NSURL *url);
FOUNDATION_EXPORT NSString *STMTransportError(NSError *error);
FOUNDATION_EXPORT NSString * const STMPairingChanged;

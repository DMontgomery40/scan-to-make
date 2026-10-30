#import <Foundation/Foundation.h>
// Credentials stay native. Metadata returned to JavaScript never contains a token.
FOUNDATION_EXPORT NSDictionary *STMReadPairing(NSError **error);
FOUNDATION_EXPORT NSDictionary *STMPairingMetadata(NSDictionary *record);
FOUNDATION_EXPORT NSURL *STMCompanionBaseURL(NSString *value);
FOUNDATION_EXPORT BOOL STMFixtureURL(NSURL *url);
FOUNDATION_EXPORT BOOL STMLocalGenerationAllowed(void);
FOUNDATION_EXPORT NSString *STMTransportError(NSError *error);
FOUNDATION_EXPORT NSString * const STMPairingChanged;

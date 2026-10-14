#import <Foundation/Foundation.h>
FOUNDATION_EXPORT NSString *STMHash(NSData *data);
FOUNDATION_EXPORT NSURL *STMArtifactURL(NSString *digest);
FOUNDATION_EXPORT NSData *STMVerifiedArtifact(NSString *digest, NSNumber *length, NSError **error);

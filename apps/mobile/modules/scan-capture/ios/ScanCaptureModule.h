#ifdef __cplusplus
// Codegen exposes C++ types. Swift imports this pod's umbrella header as
// Objective-C, so only the Objective-C++ bridge may import the generated spec.
#import <React/RCTInvalidating.h>
#import <ScanCaptureSpec/ScanCaptureSpec.h>

@interface ScanCaptureModule : NativeScanCaptureSpecBase <NativeScanCaptureSpec, RCTInvalidating>
@end
#endif

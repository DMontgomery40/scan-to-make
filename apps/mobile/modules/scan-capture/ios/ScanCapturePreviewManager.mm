#import <React/RCTViewManager.h>
#import <ARKit/ARKit.h>
#if __has_include("ScanCapture/ScanCapture-Swift.h")
#import "ScanCapture/ScanCapture-Swift.h"
#else
#import "ScanCapture-Swift.h"
#endif
@interface ScanCapturePreviewManager : RCTViewManager
@end
@implementation ScanCapturePreviewManager
RCT_EXPORT_MODULE(ScanCapturePreview)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (UIView *)view { return [[ScanCapturePreview alloc] initWithFrame:CGRectZero options:nil]; }
@end

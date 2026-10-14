#import <React/RCTViewManager.h>
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#import "ScanToMake-Swift.h"

@interface STMActionButtonManager : RCTViewManager
@end

@implementation STMActionButtonManager
RCT_EXPORT_MODULE(STMActionButton)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (UIView *)view { return [[STMActionButton alloc] initWithFrame:CGRectZero]; }
RCT_EXPORT_VIEW_PROPERTY(buttonTitle, NSString)
RCT_EXPORT_VIEW_PROPERTY(spokenLabel, NSString)
RCT_EXPORT_VIEW_PROPERTY(hint, NSString)
RCT_EXPORT_VIEW_PROPERTY(primary, BOOL)
RCT_EXPORT_VIEW_PROPERTY(compact, BOOL)
RCT_EXPORT_VIEW_PROPERTY(disabled, BOOL)
RCT_EXPORT_VIEW_PROPERTY(onPress, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onSizeChange, RCTDirectEventBlock)
@end

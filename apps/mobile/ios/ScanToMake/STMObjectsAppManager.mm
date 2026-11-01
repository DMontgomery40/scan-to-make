#import <React/RCTViewManager.h>
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#import "ScanToMake-Swift.h"

// The SwiftUI app (Objects/ObjectsApp.swift) as a React Native view, so the shell keeps pairing,
// links and credential refresh while the app itself is native iOS 27 design.
@interface STMObjectsAppManager : RCTViewManager
@end

@implementation STMObjectsAppManager
RCT_EXPORT_MODULE(STMObjectsApp)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (UIView *)view { return [[STMObjectsAppView alloc] initWithFrame:CGRectZero]; }
RCT_EXPORT_VIEW_PROPERTY(pairingKey, NSNumber)
RCT_EXPORT_VIEW_PROPERTY(onPair, RCTDirectEventBlock)
@end

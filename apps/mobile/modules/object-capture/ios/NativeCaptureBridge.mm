#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(NativeCaptureCoordinator, NSObject)
RCT_EXTERN_METHOD(status:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(drafts:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(start:(NSDictionary *)origin resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
@end

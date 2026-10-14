// Minimal bridge types for exercising the unchanged Objective-C adapter on macOS.
#import <Foundation/Foundation.h>
typedef void (^RCTPromiseResolveBlock)(id result);
typedef void (^RCTPromiseRejectBlock)(NSString *code, NSString *message, NSError *error);
@protocol RCTBridgeModule <NSObject>
@end
#define RCT_EXPORT_MODULE()
#define RCT_REMAP_METHOD(js_name, method) - (void)method

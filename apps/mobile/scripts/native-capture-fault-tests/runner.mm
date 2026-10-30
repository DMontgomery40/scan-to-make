// Simulator-only host. Compiles the production bridge unchanged; React and
// Keychain seams supply a genuine disposable pairing record. No product bypass.
#import <UIKit/UIKit.h>
#import <CommonCrypto/CommonDigest.h>
#import "../../modules/local-project-storage/ios/RetainedCaptureBridge.mm"
static NSDictionary *config;
static UIViewController *rootController;
NSDictionary *STMReadPairing(NSError **error) { return config[@"pairing"]; }
NSURL *STMCompanionBaseURL(NSString *value) {
  return [value isEqual:@"http://127.0.0.1:9078"] ? [NSURL URLWithString:value] : nil;
}
NSString *STMTransportError(NSError *error) { return error.code == NSURLErrorCancelled ? @"cancelled" : @"network-error"; }
NSString * const STMPairingChanged = @"TestPairingChanged";
NSString *STMHash(NSData *data) {
  unsigned char hash[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes,(CC_LONG)data.length,hash);
  NSMutableString *result=[NSMutableString new]; for(int i=0;i<CC_SHA256_DIGEST_LENGTH;i++)[result appendFormat:@"%02x",hash[i]];return result;
}
UIViewController *RCTPresentedViewController(void) { return rootController; }
static void Require(BOOL condition, NSString *message) {
  if (!condition) { fprintf(stderr,"FAIL: %s\n",message.UTF8String); exit(1); }
}
// Contract declaration lets the pre-implementation regression reach the missing selector.
@interface RetainedCaptureBridge (NativeAdoptionContract)
- (void)adoptNativeOutput:(NSString *)runID resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
@end
static NSArray *AdoptionCases(void) {
  NSURL *root=[[[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask] firstObject] URLByAppendingPathComponent:@"NativeCaptures"];
  NSMutableArray *results=[NSMutableArray new];
  for(NSString *mode in @[@"valid",@"traversal",@"hash",@"size",@"type",@"oversized",@"manifest-link",@"run-link",@"models-link",@"output-link",@"not-ready"]){
    NSString *runID=NSUUID.UUID.UUIDString.lowercaseString;
    NSURL *run=[root URLByAppendingPathComponent:runID],*models=[run URLByAppendingPathComponent:@"Models"],*output=[models URLByAppendingPathComponent:@"model-mobile.usdz"],*manifest=[run URLByAppendingPathComponent:@"manifest.json"];
    Require([NSFileManager.defaultManager createDirectoryAtURL:models withIntermediateDirectories:YES attributes:nil error:nil],@"fixture directories");
    NSData *bytes=[@"abc" dataUsingEncoding:NSUTF8StringEncoding];Require([bytes writeToURL:output atomically:YES],@"fixture model");
    NSMutableDictionary *file=[@{@"sha256":STMHash(bytes),@"byteLength":@3,@"mediaType":@"model/vnd.usdz+zip"} mutableCopy];
    if([mode isEqual:@"hash"])file[@"sha256"]=[@"f" stringByPaddingToLength:64 withString:@"f" startingAtIndex:0];
    if([mode isEqual:@"size"])file[@"byteLength"]=@2;
    if([mode isEqual:@"type"])file[@"mediaType"]=@"model/obj";
    if([mode isEqual:@"oversized"])file[@"byteLength"]=@(32*1024*1024+1);
    NSDictionary *draft=@{@"formatVersion":@1,@"runID":runID,@"status":[mode isEqual:@"not-ready"]?@"stopping":@"ready",@"file":file};
    Require([[NSJSONSerialization dataWithJSONObject:draft options:0 error:nil] writeToURL:manifest atomically:YES],@"fixture manifest");
    NSURL *link=nil;
    if([mode isEqual:@"manifest-link"])link=manifest;
    if([mode isEqual:@"run-link"])link=run;
    if([mode isEqual:@"models-link"])link=models;
    if([mode isEqual:@"output-link"])link=output;
    if(link){NSURL *outside=[root URLByAppendingPathComponent:[NSUUID.UUID.UUIDString stringByAppendingString:@"-outside"]];Require([NSFileManager.defaultManager moveItemAtURL:link toURL:outside error:nil],@"move fixture target");Require([NSFileManager.defaultManager createSymbolicLinkAtURL:link withDestinationURL:outside error:nil],@"fixture symlink");}
    [NSFileManager.defaultManager removeItemAtURL:FileURL(file) error:nil];
    __block BOOL resolved=NO,rejected=NO;
    RetainedCaptureBridge *bridge=[RetainedCaptureBridge new];
    [bridge adoptNativeOutput:[mode isEqual:@"traversal"]?@"../outside":runID resolve:^(id value){resolved=YES;Require([value isEqual:file],@"adopted descriptor identity");} reject:^(NSString*c,NSString*m,NSError*e){rejected=YES;}];
    BOOL valid=[mode isEqual:@"valid"];
    Require(valid?(resolved&&!rejected&&Verified(file)!=nil):(!resolved&&rejected&&Verified(file)==nil),[@"adoption result " stringByAppendingString:mode]);
    if(valid)Require([[NSData dataWithContentsOfURL:output] isEqual:bytes],@"adoption preserves original");
    [results addObject:@{@"mode":mode,@"passed":@YES}];
  }
  return results;
}
@interface Driver : NSObject
@property RetainedCaptureBridge *bridge;
@property NSMutableArray *results;
@property NSArray *modes;
@property NSUInteger index;
@property NSUInteger settlements;
@property NSUInteger partialBytes;
@end
@implementation Driver
- (void)mode:(NSString*)mode then:(void(^)(void))then {
  NSMutableURLRequest *req=[NSMutableURLRequest requestWithURL:[NSURL URLWithString:[@"http://127.0.0.1:9078/__fixture/mode/" stringByAppendingString:mode]]];
  req.HTTPMethod=@"POST";[req setValue:config[@"faultKey"] forHTTPHeaderField:@"X-Fixture-Key"];
  [[[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData*d,NSURLResponse*r,NSError*e){
    dispatch_async(dispatch_get_main_queue(),^{ Require(!e&&[(NSHTTPURLResponse*)r statusCode]==204,@"fixture mode control");then(); });
  }] resume];
}
- (void)next {
  if(self.index==self.modes.count){
    NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"runId":config[@"runId"],@"passed":@YES,@"cases":self.results,@"productionBridge":@"RetainedCaptureBridge.mm",@"seams":@[@"React dispatch",@"pairing record storage"]} options:NSJSONWritingPrettyPrinted error:nil];
    NSURL *out=[[[NSFileManager defaultManager] URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"results.json"];
    Require([data writeToURL:out atomically:YES],@"write receipts");printf("NATIVE_CAPTURE_FAULTS_PASS %lu\n",(unsigned long)self.results.count);fflush(stdout);exit(0);
  }
  NSString *mode=self.modes[self.index];NSDictionary *file=config[@"request"][@"artifact"];
  [NSFileManager.defaultManager removeItemAtURL:FileURL(file) error:nil];Require(!Verified(file),@"fresh isolated cache");self.settlements=0;self.partialBytes=0;
  [self mode:mode then:^{
    [self.bridge requestOptions:config[@"request"] resolve:^(id result){Require(NO,@"fault request unexpectedly resolved");} reject:^(NSString*code,NSString*message,NSError*error){
      self.settlements++;NSString *expected=[mode isEqual:@"oversized"]?@"payload-too-large":[mode isEqual:@"delayed"]?@"cancelled":@"verification-failed";
      Require([code isEqual:expected],[@"unexpected rejection: " stringByAppendingString:code]);
      Require(!Verified(file),@"invalid file cached");__block BOOL rejected=NO;
      [self.bridge presentFile:file share:NO resolve:^(id r){Require(NO,@"invalid file presented");} reject:^(NSString*c,NSString*m,NSError*e){rejected=[c isEqual:@"verification-failed"]; }];
      Require(rejected&&!rootController.presentedViewController,@"invalid presentation not blocked");
      // Begin a valid retry immediately in the rejection callback. Late callbacks
      // from the cancelled task must not cancel or settle the new request.
      [self mode:@"ok" then:^{[self retry:mode attempt:0];}];
    }];
    if([mode isEqual:@"delayed"])[self cancelWhenStreaming:0];
  }];
}
- (void)cancelWhenStreaming:(NSUInteger)attempt {
  if(self.bridge.received.length>0){
    Require(self.bridge.received.length<[config[@"request"][@"artifact"][@"byteLength"] unsignedIntegerValue],@"cancellation must interrupt partial bytes");
    self.partialBytes=self.bridge.received.length;
    [self.bridge cancelResolve:^(id r){} reject:^(NSString*c,NSString*m,NSError*e){Require(NO,@"cancel failed");}];return;
  }
  Require(attempt<100,@"delayed stream never began");
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,20*NSEC_PER_MSEC),dispatch_get_main_queue(),^{[self cancelWhenStreaming:attempt+1];});
}
- (void)retry:(NSString*)mode attempt:(NSUInteger)attempt {
  [self.bridge requestOptions:config[@"request"] resolve:^(id result){
    if([result[@"status"] integerValue]==429&&attempt<10){dispatch_after(dispatch_time(DISPATCH_TIME_NOW,50*NSEC_PER_MSEC),dispatch_get_main_queue(),^{[self retry:mode attempt:attempt+1];});return;}
    Require([result[@"status"] integerValue]==200,@"valid retry status");NSDictionary *file=config[@"request"][@"artifact"];
    Require(Verified(file)!=nil,@"valid retry not cached");Require(self.settlements==1,@"fault promise settled twice");
    [self.bridge presentFile:file share:NO resolve:^(id r){
      Require([rootController.presentedViewController isKindOfClass:UINavigationController.class],@"valid mesh viewer not presented");
      UINavigationController *nav=(id)rootController.presentedViewController;
      Require([nav.topViewController.view isKindOfClass:SCNView.class],@"mesh view absent");
      [self.results addObject:@{@"mode":mode,@"rejected":@YES,@"partialBytesBeforeCancel":@(self.partialBytes),@"invalidCacheAbsent":@YES,@"invalidPresentationBlocked":@YES,@"retryVerified":@YES,@"retryMeshPresented":@YES,@"byteLength":file[@"byteLength"],@"sha256":file[@"sha256"]}];
      [rootController dismissViewControllerAnimated:NO completion:^{self.index++;[self next];}];
    } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,[@"valid presentation failed: " stringByAppendingString:c]);}];
  } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,[@"valid retry rejected: " stringByAppendingString:c]);}];
}
@end
@interface SceneDelegate : UIResponder<UIWindowSceneDelegate>
@property(nonatomic,strong) UIWindow *window;
@property Driver *driver;
@end
@implementation SceneDelegate
- (void)scene:(UIScene*)scene willConnectToSession:(UISceneSession*)session options:(UISceneConnectionOptions*)options {
  NSData *data=[NSData dataWithContentsOfURL:[NSBundle.mainBundle URLForResource:@"config" withExtension:@"json"]];config=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];Require(config!=nil,@"private fixture config");
  self.window=[[UIWindow alloc] initWithWindowScene:(UIWindowScene*)scene];rootController=[UIViewController new];rootController.view.backgroundColor=UIColor.whiteColor;self.window.rootViewController=rootController;[self.window makeKeyAndVisible];
  if([config[@"adoptionOnly"] boolValue]){
    NSArray *cases=AdoptionCases();
    NSURL *out=[[[NSFileManager defaultManager] URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"results.json"];
    Require([[NSJSONSerialization dataWithJSONObject:@{@"passed":@YES,@"cases":cases} options:NSJSONWritingPrettyPrinted error:nil] writeToURL:out atomically:YES],@"write adoption receipts");
    printf("NATIVE_ADOPTION_PASS %lu\n",(unsigned long)cases.count);fflush(stdout);exit(0);
  }
  self.driver=[Driver new];self.driver.bridge=[RetainedCaptureBridge new];self.driver.results=[NSMutableArray new];self.driver.modes=@[@"wrong-hash",@"wrong-type",@"wrong-bytes",@"oversized",@"delayed"];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),dispatch_get_main_queue(),^{[self.driver next];});
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,60*NSEC_PER_SEC),dispatch_get_main_queue(),^{Require(NO,@"60-second test bound exceeded");});
}
@end
@interface AppDelegate : UIResponder<UIApplicationDelegate>
@end
@implementation AppDelegate
@end
int main(int argc,char**argv){@autoreleasepool{return UIApplicationMain(argc,argv,nil,NSStringFromClass(AppDelegate.class));}}

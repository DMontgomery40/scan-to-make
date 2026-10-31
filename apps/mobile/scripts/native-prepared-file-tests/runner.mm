#import <UIKit/UIKit.h>
#import <CommonCrypto/CommonDigest.h>
#import "../../modules/local-project-storage/ios/CompanionPairing.mm"
#import "../../modules/local-project-storage/ios/PreparedFileBridge.mm"
NSString *STMHash(NSData *data){unsigned char hash[CC_SHA256_DIGEST_LENGTH];CC_SHA256(data.bytes,(CC_LONG)data.length,hash);NSMutableString*s=[NSMutableString new];for(int i=0;i<CC_SHA256_DIGEST_LENGTH;i++)[s appendFormat:@"%02x",hash[i]];return s;}
// Test-local copy of ArtifactBridge's shared-cache verified read, which
// PreparedFileBridge now links against for production source bytes.
NSURL *STMArtifactURL(NSString *digest){if(![[NSPredicate predicateWithFormat:@"SELF MATCHES %@",@"[a-f0-9]{64}"] evaluateWithObject:digest])return nil;NSURL *root=[[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];return [[root URLByAppendingPathComponent:@"Artifacts" isDirectory:YES] URLByAppendingPathComponent:[digest stringByAppendingString:@".stl"]];}
NSData *STMVerifiedArtifact(NSString *digest,NSNumber *length,NSError **error){NSURL *url=STMArtifactURL(digest);if(!url||length.doubleValue<1||length.doubleValue>32*1024*1024||length.doubleValue!=length.unsignedIntegerValue)return nil;NSData *data=[NSData dataWithContentsOfURL:url options:0 error:error];return data&&data.length==length.unsignedIntegerValue&&[STMHash(data) isEqualToString:digest]?data:nil;}
static NSDictionary *config;
static void Require(BOOL ok,NSString *why){if(!ok){fprintf(stderr,"FAIL %s\n",why.UTF8String);exit(1);}}
@interface Driver:NSObject
@property CompanionPairing *pair;
@property PreparedFileBridge *files;
@property NSUInteger index;
@property NSMutableArray *results;
@property NSMutableArray *discovered;
@property BOOL producedDiscovery;
@end
@implementation Driver
- (void)request:(NSDictionary*)options then:(void(^)(NSDictionary*))then attempt:(NSUInteger)n {
 [self.files requestOptions:options resolve:^(id r){if([r[@"status"] integerValue]==429&&n<5){dispatch_after(dispatch_time(DISPATCH_TIME_NOW,50*NSEC_PER_MSEC),dispatch_get_main_queue(),^{[self request:options then:then attempt:n+1];});return;}BOOL unsupported=[r[@"status"] integerValue]==400&&[options[@"path"] containsString:@"&productionVersion=1"]&&![options[@"path"] containsString:@"&cursor="];
 Require([r[@"status"] integerValue]==200||unsupported,@"verified GET status");if(!unsupported)Require([r[@"etag"] isEqual:config[@"prepared"][@"etag"]],@"exact ETag");then(r);} reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];
}
// KAN-102: production/approval bridge shapes. The fixture companion has app
// production disabled and holds no prints:approve scope, so well-shaped
// requests must fail closed over the wire and wrong shapes locally.
- (void)productionChecks:(void(^)(void))done {
 NSDictionary *project=config[@"prepared"][@"project"],*expected=[config[@"prepared"][@"jobs"] firstObject],*pairing=STMReadPairing(nil);
 NSString *base=[NSString stringWithFormat:@"/v1/saved-projects/%@/prepared-jobs/%@?projectRevision=%@",project[@"id"],expected[@"jobId"],project[@"revision"]];
 NSData *source=[@"synthetic source" dataUsingEncoding:NSUTF8StringEncoding];
 NSString *sha=STMHash(source);NSURL *url=STMArtifactURL(sha);
 [NSFileManager.defaultManager createDirectoryAtURL:url.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
 Require([source writeToURL:url atomically:YES],@"synthetic source cache");
 NSDictionary *sourceRef=@{@"sha256":sha,@"byteLength":@(source.length),@"mediaType":@"model/stl"};
 NSString *ctx=Context(pairing),*etag=config[@"prepared"][@"etag"];
 NSString *(^sub)(NSString*)=^(NSString*s){return [base stringByReplacingOccurrencesOfString:@"?" withString:[@"/" stringByAppendingFormat:@"%@?",s]];};
 for(NSDictionary *bad in @[@{@"context":ctx,@"method":@"GET",@"path":sub(@"intent"),@"etag":etag},
   @{@"context":ctx,@"method":@"POST",@"path":sub(@"production"),@"etag":etag,@"body":@"{}"},
   @{@"context":ctx,@"method":@"POST",@"path":sub(@"intent"),@"etag":etag,@"source":sourceRef}]){
  __block BOOL rejected=NO;
  [self.files requestOptions:bad resolve:^(id r){Require(NO,@"invalid production shape accepted");} reject:^(NSString*c,NSString*m,NSError*e){rejected=[c isEqual:@"invalid-request"];}];
  Require(rejected,@"production shape rejection");
 }
 NSDictionary *production=@{@"context":ctx,@"method":@"POST",@"path":sub(@"production"),@"etag":etag,@"source":sourceRef};
 [self.files requestOptions:production resolve:^(id r){
  NSDictionary *body=[NSJSONSerialization JSONObjectWithData:[r[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  Require([r[@"status"] integerValue]==404&&[body[@"error"][@"code"] isEqual:@"not-available"],@"disabled app production fails closed");
  NSDictionary *intent=@{@"context":ctx,@"method":@"POST",@"path":sub(@"intent"),@"etag":etag,@"body":[NSString stringWithFormat:@"{\"jobSha256\":\"%@\",\"confirmed\":true}",sha]};
  [self.files requestOptions:intent resolve:^(id ri){
   NSDictionary *ib=[NSJSONSerialization JSONObjectWithData:[ri[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
   Require([ri[@"status"] integerValue]==403&&[ib[@"error"][@"code"] isEqual:@"scope-denied"],@"prints:approve scope enforced");
   NSDictionary *attempt=@{@"context":ctx,@"method":@"GET",@"path":sub(@"attempt"),@"etag":etag};
   [self.files requestOptions:attempt resolve:^(id ra){
    NSDictionary *ab=[NSJSONSerialization JSONObjectWithData:[ra[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    Require([ra[@"status"] integerValue]==200&&ab[@"intent"]==NSNull.null&&ab[@"linkedAttempt"]==NSNull.null,@"attempt status before approval");done();
   } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];
  } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];
 } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];
}
- (void)next {
 NSArray *jobs=config[@"prepared"][@"jobs"];
 if(self.index==jobs.count){
  [self productionChecks:^{ [self writeReceipt]; }];return;
 }
 [self nextCase];
}
- (void)writeReceipt {
  NSInteger phase=[NSUserDefaults.standardUserDefaults integerForKey:@"phase"]+1;
  [NSUserDefaults.standardUserDefaults setInteger:phase forKey:@"phase"];
  if(phase==2){[self.pair disconnectResolve:^(id r){Require([r[@"state"] isEqual:@"disconnected"],@"test credential cleanup");} reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];}
  NSDictionary *receipt=@{@"phase":@(phase),@"passed":@YES,@"runId":config[@"runId"],@"preparedOnlyPairing":@YES,@"discoveryPagination":@YES,@"productionBridge":@YES,@"producedDiscovery":@(self.producedDiscovery),@"discovered":self.discovered,@"cases":self.results};
  NSURL *url=[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
  url=[url URLByAppendingPathComponent:[NSString stringWithFormat:@"results-%ld.json",(long)phase]];
  Require([[NSJSONSerialization dataWithJSONObject:receipt options:NSJSONWritingPrettyPrinted error:nil] writeToURL:url atomically:YES],@"receipt");printf("NATIVE_PREPARED_PASS phase=%ld\n",(long)phase);fflush(stdout);exit(0);
}
- (void)nextCase {
 NSArray *jobs=config[@"prepared"][@"jobs"];
 NSDictionary *expected=jobs[self.index],*job=expected[@"job"],*project=config[@"prepared"][@"project"];
 NSString *path=[NSString stringWithFormat:@"/v1/saved-projects/%@/prepared-jobs/%@?projectRevision=%@",project[@"id"],expected[@"jobId"],project[@"revision"]];
 NSDictionary *pairing=STMReadPairing(nil);Require(![pairing[@"scopes"] containsObject:@"generation:create"],@"prepared-only credential");
 NSMutableDictionary *o=[@{@"context":Context(pairing),@"method":@"GET",@"path":path,@"etag":config[@"prepared"][@"etag"]} mutableCopy];
 for(NSDictionary *bad in @[@{@"method":@"POST"},@{@"path":@"/v1/generate"},@{@"path":[path stringByAppendingString:@"&extra=1"]},@{@"path":[path stringByAppendingString:@"&productionVersion=1"]}]){
  NSMutableDictionary *badOptions=[o mutableCopy];[badOptions addEntriesFromDictionary:bad];__block BOOL rejected=NO;
  [self.files requestOptions:badOptions resolve:^(id r){Require(NO,@"unexpected route accepted");} reject:^(NSString*c,NSString*m,NSError*e){rejected=[c isEqual:@"invalid-request"];}];Require(rejected,@"strict route rejection");
 }
 [self request:o then:^(NSDictionary*r){
  NSDictionary *remote=[NSJSONSerialization JSONObjectWithData:[r[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];Require([remote[@"job"] isEqual:job]&&[remote[@"jobId"] isEqual:expected[@"jobId"]],@"complete actual job response identity");
  o[@"path"]=[path stringByReplacingOccurrencesOfString:@"?" withString:@"/artifacts/printable?"];o[@"artifact"]=job[@"printableArtifact"];
  [self request:o then:^(NSDictionary*download){
   Require([download[@"file"] isEqual:job[@"printableArtifact"]],@"download identity");
   [self.files exportFile:job[@"printableArtifact"] resolve:^(id saved){
    NSData *bytes=[NSData dataWithContentsOfFile:saved[@"path"]];Require(bytes.length==[job[@"printableArtifact"][@"byteLength"] unsignedIntegerValue]&&[STMHash(bytes) isEqual:job[@"printableArtifact"][@"sha256"]],@"exact exported bytes");
    [self.results addObject:@{@"jobId":expected[@"jobId"],@"mediaType":job[@"printableArtifact"][@"mediaType"],@"sha256":saved[@"sha256"],@"byteLength":saved[@"byteLength"],@"exportName":[saved[@"path"] lastPathComponent]}];self.index++;[self next];
   } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];
  } attempt:0];
 } attempt:0];
}
- (void)discoverPage:(NSString*)cursor produced:(BOOL)produced {
 NSDictionary *project=config[@"prepared"][@"project"],*pairing=STMReadPairing(nil);
 NSString *path=[NSString stringWithFormat:@"/v1/saved-projects/%@/prepared-jobs?projectRevision=%@&limit=1%@%@",project[@"id"],project[@"revision"],produced?@"&productionVersion=1":@"",cursor?[@"&cursor=" stringByAppendingString:cursor]:@""];
 NSMutableDictionary *o=[@{@"context":Context(pairing),@"method":@"GET",@"path":path,@"etag":config[@"prepared"][@"etag"]} mutableCopy];
 if(!cursor)for(NSString *suffix in @[@"&extra=1",@"&limit=1",@"&productionVersion=2",@"&productionVersion=1&productionVersion=1",@"&cursor=bad%2Fcursor"]){
  NSMutableDictionary *bad=[o mutableCopy];bad[@"path"]=[path stringByAppendingString:suffix];__block BOOL rejected=NO;
  [self.files requestOptions:bad resolve:^(id r){Require(NO,@"unexpected collection query accepted");} reject:^(NSString*c,NSString*m,NSError*e){rejected=[c isEqual:@"invalid-request"];}];Require(rejected,@"strict collection query rejection");
 }
 [self request:o then:^(NSDictionary*r){
  NSDictionary *page=[NSJSONSerialization JSONObjectWithData:[r[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  if([r[@"status"] integerValue]==400){Require(!cursor&&produced&&[page[@"error"][@"code"] isEqual:@"invalid-request"],@"first-page compatibility fallback only");[self discoverPage:nil produced:NO];return;}
  Require([page[@"requiresVerifiedGet"] boolValue]&&[page[@"jobs"] count]<=1,@"bounded discovery page");
  for(NSDictionary *summary in page[@"jobs"]){NSString *identity=summary[@"jobId"];Require(![self.discovered containsObject:identity],@"discovery does not repeat a handle");[self.discovered addObject:identity];}
  Require(self.discovered.count<100,@"discovery bound");
  if([page[@"nextCursor"] isKindOfClass:NSString.class]){Require(![cursor isEqual:page[@"nextCursor"]],@"cursor advances");[self discoverPage:page[@"nextCursor"] produced:produced];return;}
  Require(page[@"nextCursor"]==NSNull.null,@"terminal cursor");self.producedDiscovery=produced;
  NSMutableArray *expected=[NSMutableArray new];for(NSDictionary *item in config[@"prepared"][@"jobs"]){if(produced||!item[@"job"][@"production"])[expected addObject:item[@"jobId"]];}
  Require([self.discovered isEqual:[expected sortedArrayUsingSelector:@selector(compare:)]],@"discovery includes exactly the compatible current jobs");[self next];
 } attempt:0];
}
- (void)discoverThenNext { self.discovered=[NSMutableArray new];[self discoverPage:nil produced:YES]; }
- (void)start {
 self.files=[PreparedFileBridge new];self.pair=[CompanionPairing new];self.results=[NSMutableArray new];
 if([NSProcessInfo.processInfo.arguments containsObject:@"--cleanup"]){[self.pair disconnectResolve:^(id r){exit(0);} reject:^(NSString*c,NSString*m,NSError*e){exit(1);}];return;}
 if([NSUserDefaults.standardUserDefaults integerForKey:@"phase"]>0){[self.pair statusResolve:^(id r){Require([r[@"state"] isEqual:@"paired"],@"pairing survived process restart");[self discoverThenNext];} reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];return;}
 [self.pair pairURL:config[@"invitation"][@"baseUrl"] code:config[@"invitation"][@"code"] deviceName:@"Prepared native fixture" resolve:^(id r){Require(r[@"token"]==nil,@"secret-free metadata");[self discoverThenNext];} reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];
}
@end
@interface SceneDelegate:UIResponder<UIWindowSceneDelegate>
@property(nonatomic,strong) UIWindow*window;
@property Driver*driver;
@end
@implementation SceneDelegate
- (void)scene:(UIScene*)scene willConnectToSession:(UISceneSession*)session options:(UISceneConnectionOptions*)options{
 config=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfURL:[NSBundle.mainBundle URLForResource:@"config" withExtension:@"json"]] options:0 error:nil];
 self.window=[[UIWindow alloc]initWithWindowScene:(UIWindowScene*)scene];self.window.rootViewController=[UIViewController new];[self.window makeKeyAndVisible];self.driver=[Driver new];[self.driver start];
 dispatch_after(dispatch_time(DISPATCH_TIME_NOW,45*NSEC_PER_SEC),dispatch_get_main_queue(),^{Require(NO,@"45-second runtime bound");});
}
@end
@interface AppDelegate:UIResponder<UIApplicationDelegate>@end
@implementation AppDelegate@end
int main(int argc,char**argv){@autoreleasepool{return UIApplicationMain(argc,argv,nil,NSStringFromClass(AppDelegate.class));}}

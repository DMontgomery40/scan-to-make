#import <UIKit/UIKit.h>
#import <CommonCrypto/CommonDigest.h>
#import "../../modules/local-project-storage/ios/CompanionPairing.mm"
#import "../../modules/local-project-storage/ios/StillsProcessingBridge.mm"
static UIViewController *rootController;
UIViewController *RCTPresentedViewController(void) { return rootController; }
NSString *STMHash(NSData *data){unsigned char hash[CC_SHA256_DIGEST_LENGTH];CC_SHA256(data.bytes,(CC_LONG)data.length,hash);NSMutableString*s=[NSMutableString new];for(int i=0;i<CC_SHA256_DIGEST_LENGTH;i++)[s appendFormat:@"%02x",hash[i]];return s;}
static NSDictionary *config;
static void Require(BOOL ok,NSString *why){if(!ok){fprintf(stderr,"FAIL %s\n",why.UTF8String);exit(1);}}
@interface Driver:NSObject
@property CompanionPairing *pair;
@property StillsProcessingBridge *bridge;
@property NSString *ctx;
@property NSData *jpeg;
@property NSDictionary *jpegFile;
@property NSDictionary *still;
@property NSDictionary *job;
@property BOOL imageUriCacheStatesChecked;
@end
@implementation Driver
- (NSString*)path:(NSString*)suffix {
 NSDictionary *media=config[@"media"],*project=media[@"project"];
 return [NSString stringWithFormat:@"/v1/saved-projects/%@/captures/%@%@projectRevision=%@",project[@"id"],media[@"captureId"],suffix,project[@"revision"]];
}
- (NSMutableDictionary*)options:(NSString*)method path:(NSString*)path {
 return [@{@"context":self.ctx,@"method":method,@"path":path,@"etag":config[@"media"][@"etag"]} mutableCopy];
}
- (void)request:(NSDictionary*)options status:(NSInteger)status then:(void(^)(NSDictionary*))then attempt:(NSUInteger)n {
 [self.bridge requestOptions:options resolve:^(id r){
  if([r[@"status"] integerValue]==429&&n<5){dispatch_after(dispatch_time(DISPATCH_TIME_NOW,50*NSEC_PER_MSEC),dispatch_get_main_queue(),^{[self request:options status:status then:then attempt:n+1];});return;}
  Require([r[@"status"] integerValue]==status,@"expected response status");
  Require([r[@"etag"] isEqual:config[@"media"][@"etag"]],@"exact ETag echo");then(r);
 } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];
}
- (void)requireImageUri:(NSDictionary*)file then:(void(^)(void))then {
 [self.bridge imageUriFile:file resolve:^(id uri){
  Require([uri isKindOfClass:NSString.class]&&[uri isEqual:FileURL(file).absoluteString],@"verified image uri");
  NSData *bytes=[NSData dataWithContentsOfURL:[NSURL URLWithString:uri]];
  Require(bytes&&[STMHash(bytes) isEqual:file[@"sha256"]],@"image uri exact bytes");then();
 } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];
}
- (void)imageUriCacheStates {
 NSData *missingBytes=[@"synthetic uncached image" dataUsingEncoding:NSUTF8StringEncoding];
 NSDictionary *missing=@{@"sha256":STMHash(missingBytes),@"byteLength":@(missingBytes.length),@"mediaType":@"image/jpeg"};
 NSURL *missingURL=FileURL(missing);
 [NSFileManager.defaultManager removeItemAtURL:missingURL error:nil];
 __block BOOL resolvedNull=NO;
 [self.bridge imageUriFile:missing resolve:^(id uri){resolvedNull=uri==NSNull.null;} reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];
 Require(resolvedNull,@"imageUri cache miss resolves null");
 NSMutableData *corrupt=[missingBytes mutableCopy];((char*)corrupt.mutableBytes)[0]^=1;
 Require(DurableWrite(corrupt,missingURL),@"write corrupt cached image");
 __block BOOL rejected=NO;
 [self.bridge imageUriFile:missing resolve:^(id uri){Require(NO,@"corrupt cached image resolved");} reject:^(NSString*c,NSString*m,NSError*e){rejected=[c isEqual:@"verification-failed"];}];
 Require(rejected,@"imageUri corrupt cache rejects");
 [NSFileManager.defaultManager removeItemAtURL:missingURL error:nil];
 self.imageUriCacheStatesChecked=YES;
}
- (void)rejects:(NSDictionary*)options code:(NSString*)code {
 __block BOOL rejected=NO;
 [self.bridge requestOptions:options resolve:^(id r){Require(NO,@"unexpected request accepted");} reject:^(NSString*c,NSString*m,NSError*e){rejected=[c isEqual:code];}];
 Require(rejected,@"strict request rejection");
}
- (void)negatives {
 NSString *stills=[self path:@"/detail-stills?"];
 NSMutableDictionary *bad;
 bad=[self options:@"GET" path:@"/v1/generate"];[self rejects:bad code:@"invalid-request"];
 bad=[self options:@"POST" path:stills];[self rejects:bad code:@"invalid-request"];
 bad=[self options:@"GET" path:[stills stringByAppendingString:@"&label=x"]];[self rejects:bad code:@"invalid-request"];
 bad=[self options:@"GET" path:[stills stringByAppendingString:@"&extra=1"]];[self rejects:bad code:@"invalid-request"];
 bad=[self options:@"PUT" path:stills];[self rejects:bad code:@"invalid-request"];
 bad=[self options:@"POST" path:[self path:@"/scan-processing?"]];[self rejects:bad code:@"invalid-request"];
 bad=[self options:@"GET" path:[self path:@"/detail-stills/44444444-4444-4444-8444-444444444444?"]];[self rejects:bad code:@"invalid-request"];
 bad=[self options:@"GET" path:[self path:@"/scan-processing/44444444-4444-4444-8444-444444444444/artifacts/evil.png?"]];bad[@"artifact"]=self.jpegFile;[self rejects:bad code:@"invalid-request"];
 bad=[self options:@"GET" path:stills];bad[@"etag"]=@"\"bad\"";[self rejects:bad code:@"invalid-request"];
 bad=[self options:@"GET" path:stills];bad[@"create"]=@YES;[self rejects:bad code:@"invalid-request"];
 bad=[self options:@"POST" path:stills];bad[@"source"]=@{@"sha256":self.jpegFile[@"sha256"],@"byteLength":@68,@"mediaType":@"model/stl"};[self rejects:bad code:@"invalid-source"];
 [self imageUriCacheStates];
}
- (void)finish {
 NSInteger phase=[NSUserDefaults.standardUserDefaults integerForKey:@"phase"]+1;
 [NSUserDefaults.standardUserDefaults setInteger:phase forKey:@"phase"];
 NSDictionary *receipt=@{@"phase":@(phase),@"passed":@YES,@"runId":config[@"runId"],@"jobId":[NSUserDefaults.standardUserDefaults stringForKey:@"jobId"]?:@"",@"pngSha256":config[@"media"][@"png"][@"sha256"],@"imageUriCacheStates":@(self.imageUriCacheStatesChecked)};
 NSURL *url=[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
 url=[url URLByAppendingPathComponent:[NSString stringWithFormat:@"results-%ld.json",(long)phase]];
 Require([[NSJSONSerialization dataWithJSONObject:receipt options:NSJSONWritingPrettyPrinted error:nil] writeToURL:url atomically:YES],@"receipt");
 printf("NATIVE_STILLS_PROCESSING_PASS phase=%ld\n",(long)phase);fflush(stdout);exit(0);
}
- (void)pollJob:(NSUInteger)n {
 Require(n<100,@"job completes within bound");
 NSString *jobId=[NSUserDefaults.standardUserDefaults stringForKey:@"jobId"];
 [self request:[self options:@"GET" path:[self path:[NSString stringWithFormat:@"/scan-processing/%@?",jobId]]] status:200 then:^(NSDictionary*r){
  NSDictionary *job=[NSJSONSerialization JSONObjectWithData:[r[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil][@"job"];
  Require([job[@"jobId"] isEqual:jobId],@"job identity");
  if([job[@"status"] isEqual:@"succeeded"]){self.job=job;[self downloadArtifacts];return;}
  Require(![job[@"status"] isEqual:@"failed"],@"job succeeds");
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,100*NSEC_PER_MSEC),dispatch_get_main_queue(),^{[self pollJob:n+1];});
 } attempt:0];
}
- (void)downloadArtifacts {
 NSString *jobId=self.job[@"jobId"];
 NSDictionary *pngRef=self.job[@"artifacts"][@"pos_x.png"];
 Require([pngRef isEqual:config[@"media"][@"png"]],@"sealed png identity");
 NSMutableDictionary *o=[self options:@"GET" path:[self path:[NSString stringWithFormat:@"/scan-processing/%@/artifacts/pos_x.png?",jobId]]];o[@"artifact"]=pngRef;
 [self request:o status:200 then:^(NSDictionary*r){
  Require([r[@"file"] isEqual:pngRef],@"png download identity");
  Require(Verified(pngRef).length==[pngRef[@"byteLength"] unsignedIntegerValue],@"verified retained png bytes");
  [self requireImageUri:pngRef then:^{}];
  NSMutableDictionary *report=[self options:@"GET" path:[self path:[NSString stringWithFormat:@"/scan-processing/%@/artifacts/report.json?",jobId]]];report[@"artifact"]=self.job[@"artifacts"][@"report.json"];
  [self request:report status:200 then:^(NSDictionary*rr){
   Require([rr[@"file"] isEqual:self.job[@"artifacts"][@"report.json"]],@"report download identity");[self deleteStill];
  } attempt:0];
 } attempt:0];
}
- (void)deleteStill {
 [self request:[self options:@"DELETE" path:[self path:[NSString stringWithFormat:@"/detail-stills/%@?",self.still[@"id"]]]] status:200 then:^(NSDictionary*r){
  NSDictionary *deleted=[NSJSONSerialization JSONObjectWithData:[r[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  Require([deleted[@"deleted"] boolValue]&&[deleted[@"stillId"] isEqual:self.still[@"id"]],@"delete receipt");
  [self request:[self options:@"GET" path:[self path:@"/detail-stills?"]] status:200 then:^(NSDictionary*rr){
   NSDictionary *list=[NSJSONSerialization JSONObjectWithData:[rr[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
   Require([list[@"stills"] count]==0,@"still removed");[self finish];
  } attempt:0];
 } attempt:0];
}
- (void)phaseOne {
 unsigned char head[4]={0xFF,0xD8,0xFF,0xE0};NSMutableData *jpeg=[NSMutableData dataWithBytes:head length:4];char pad[64];memset(pad,7,sizeof(pad));[jpeg appendBytes:pad length:sizeof(pad)];
 self.jpeg=jpeg;self.jpegFile=@{@"sha256":STMHash(jpeg),@"byteLength":@(jpeg.length),@"mediaType":@"image/jpeg"};
 Require(Cache(jpeg,self.jpegFile),@"cache synthetic jpeg source");
 [self negatives];
 NSMutableDictionary *upload=[self options:@"POST" path:[[self path:@"/detail-stills?"] stringByAppendingString:@"&label=USB-C%20port"]];upload[@"source"]=self.jpegFile;
 [self request:upload status:201 then:^(NSDictionary*r){
  NSDictionary *still=[NSJSONSerialization JSONObjectWithData:[r[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil][@"still"];
  Require([still[@"sha256"] isEqual:self.jpegFile[@"sha256"]]&&[still[@"label"] isEqual:@"USB-C port"]&&[still[@"ordinal"] integerValue]==0,@"uploaded still record");self.still=still;
  [self request:[self options:@"GET" path:[self path:@"/detail-stills?"]] status:200 then:^(NSDictionary*rr){
   NSDictionary *list=[NSJSONSerialization JSONObjectWithData:[rr[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
   Require([list[@"stills"] count]==1&&[list[@"stills"][0] isEqual:still],@"listed still");
   NSMutableDictionary *download=[self options:@"GET" path:[self path:[NSString stringWithFormat:@"/detail-stills/%@?",still[@"id"]]]];
   download[@"artifact"]=@{@"sha256":still[@"sha256"],@"byteLength":still[@"byteLength"],@"mediaType":still[@"mediaType"]};
   [self request:download status:200 then:^(NSDictionary*rrr){
    Require([rrr[@"file"] isEqual:download[@"artifact"]]&&[Verified(download[@"artifact"]) isEqual:self.jpeg],@"exact downloaded still bytes");
    [self requireImageUri:download[@"artifact"] then:^{}];
    NSMutableDictionary *start=[self options:@"POST" path:[self path:@"/scan-processing?"]];
    start[@"body"]=@"{\"reference\":{\"dimensionsMm\":[60.6,45.2,21.7]}}";
    [self request:start status:202 then:^(NSDictionary*rrrr){
     NSDictionary *job=[NSJSONSerialization JSONObjectWithData:[rrrr[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil][@"job"];
     Require([job[@"status"] isEqual:@"queued"]&&[job[@"previewOnly"] boolValue],@"queued job");
     [NSUserDefaults.standardUserDefaults setObject:job[@"jobId"] forKey:@"jobId"];[self pollJob:0];
    } attempt:0];
   } attempt:0];
  } attempt:0];
 } attempt:0];
}
- (void)phaseTwo {
 NSString *jobId=[NSUserDefaults.standardUserDefaults stringForKey:@"jobId"];Require(jobId.length>0,@"persisted job id");
 [self request:[self options:@"GET" path:[self path:@"/scan-processing?"]] status:200 then:^(NSDictionary*listed){
  NSArray *jobs=[NSJSONSerialization JSONObjectWithData:[listed[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil][@"jobs"];
  BOOL found=NO;for(NSDictionary *item in jobs)if([item[@"jobId"] isEqual:jobId]&&[item[@"status"] isEqual:@"succeeded"])found=YES;
  Require(found,@"finished job listed after restart");
 [self request:[self options:@"GET" path:[self path:[NSString stringWithFormat:@"/scan-processing/%@?",jobId]]] status:200 then:^(NSDictionary*r){
  NSDictionary *job=[NSJSONSerialization JSONObjectWithData:[r[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil][@"job"];
  Require([job[@"status"] isEqual:@"succeeded"]&&[job[@"artifacts"] count]==13,@"succeeded job survives restart");
  [self request:[self options:@"GET" path:[self path:@"/detail-stills?"]] status:200 then:^(NSDictionary*rr){
   NSDictionary *list=[NSJSONSerialization JSONObjectWithData:[rr[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
   Require([list[@"stills"] count]==0,@"deletion survives restart");
   [self.pair disconnectResolve:^(id done){Require([done[@"state"] isEqual:@"disconnected"],@"test credential cleanup");[self finish];} reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];
  } attempt:0];
 } attempt:0];
 } attempt:0];
}
- (void)withContext:(void(^)(void))then {
 [self.bridge contextResolve:^(id r){self.ctx=r;NSDictionary *pairing=STMReadPairing(nil);Require([r isEqual:Context(pairing)],@"bridge context");Require([pairing[@"scopes"] containsObject:@"captures:read"]&&[pairing[@"scopes"] containsObject:@"captures:import"],@"capture scopes");then();} reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];
}
- (void)start {
 self.bridge=[StillsProcessingBridge new];self.pair=[CompanionPairing new];
 if([NSProcessInfo.processInfo.arguments containsObject:@"--cleanup"]){[self.pair disconnectResolve:^(id r){exit(0);} reject:^(NSString*c,NSString*m,NSError*e){exit(1);}];return;}
 if([NSUserDefaults.standardUserDefaults integerForKey:@"phase"]>0){[self.pair statusResolve:^(id r){Require([r[@"state"] isEqual:@"paired"],@"pairing survived process restart");[self withContext:^{[self phaseTwo];}];} reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];return;}
 [self.pair pairURL:config[@"invitation"][@"baseUrl"] code:config[@"invitation"][@"code"] deviceName:@"Stills processing native fixture" resolve:^(id r){Require(r[@"token"]==nil,@"secret-free metadata");[self withContext:^{[self phaseOne];}];} reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];
}
@end
@interface SceneDelegate:UIResponder<UIWindowSceneDelegate>
@property(nonatomic,strong) UIWindow*window;
@property Driver*driver;
@end
@implementation SceneDelegate
- (void)scene:(UIScene*)scene willConnectToSession:(UISceneSession*)session options:(UISceneConnectionOptions*)options{
 config=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfURL:[NSBundle.mainBundle URLForResource:@"config" withExtension:@"json"]] options:0 error:nil];
 self.window=[[UIWindow alloc]initWithWindowScene:(UIWindowScene*)scene];rootController=[UIViewController new];self.window.rootViewController=rootController;[self.window makeKeyAndVisible];self.driver=[Driver new];[self.driver start];
 dispatch_after(dispatch_time(DISPATCH_TIME_NOW,45*NSEC_PER_SEC),dispatch_get_main_queue(),^{Require(NO,@"45-second runtime bound");});
}
@end
@interface AppDelegate:UIResponder<UIApplicationDelegate>@end
@implementation AppDelegate@end
int main(int argc,char**argv){@autoreleasepool{return UIApplicationMain(argc,argv,nil,NSStringFromClass(AppDelegate.class));}}

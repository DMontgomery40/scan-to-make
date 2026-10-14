#import "../../modules/local-project-storage/ios/LocalProjectStorage.mm"
@interface TestStorage : LocalProjectStorage
@property NSString *testPath;
@end
@implementation TestStorage
- (sqlite3 *)openDatabase {
  sqlite3 *db = NULL;
  if (sqlite3_open(self.testPath.UTF8String, &db) != SQLITE_OK) return NULL;
  sqlite3_busy_timeout(db, 5000);
  if (sqlite3_exec(db, "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY NOT NULL, bytes BLOB NOT NULL)", NULL, NULL, NULL) != SQLITE_OK) { sqlite3_close(db); return NULL; }
  return db;
}
@end
int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 4) return 2;
    TestStorage *store = [TestStorage new];
    store.testPath = @(argv[1]);
    __block int result = 0;
    RCTPromiseRejectBlock reject = ^(NSString *code, NSString *message, NSError *error) { result = 3; };
    if (strcmp(argv[2], "cas") == 0 && argc == 6) {
      [store casId:@(argv[3]) expected:strcmp(argv[4], "ABSENT") == 0 ? nil : @(argv[4]) next:@(argv[5]) resolve:^(id value) { puts([value boolValue] ? "true" : "false"); } reject:reject];
    } else if (strcmp(argv[2], "read") == 0) {
      [store readId:@(argv[3]) resolve:^(id value) { if (value != (id)kCFNull) fwrite([value UTF8String], 1, [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding], stdout); } reject:reject];
    } else { return 2; }
    return result;
  }
}

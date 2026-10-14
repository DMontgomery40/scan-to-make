#import <React/RCTViewManager.h>
#import <React/RCTComponent.h>
#import <SceneKit/SceneKit.h>
#import "ArtifactFiles.h"
#include <cmath>
#include <cstring>

@interface ArtifactMeshView : SCNView
@property (nonatomic, copy) NSDictionary *artifact;
@property (nonatomic, copy) RCTDirectEventBlock onReady;
@property (nonatomic, copy) RCTDirectEventBlock onFailure;
@property NSUInteger loadSequence;
@end
@implementation ArtifactMeshView
- (instancetype)init {
  if (self = [super init]) {
    self.backgroundColor = [UIColor colorWithRed:.88 green:.91 blue:.85 alpha:1];
    self.allowsCameraControl = YES; self.autoenablesDefaultLighting = NO;
    self.accessibilityLabel = @"Generated drawer mesh. Drag to rotate; pinch to zoom.";
    self.isAccessibilityElement = YES;
  }
  return self;
}
- (void)setArtifact:(NSDictionary *)artifact {
  _artifact = [artifact copy]; self.scene = nil;
  NSUInteger sequence = ++self.loadSequence;
  NSString *digest = artifact[@"sha256"]; NSNumber *length = artifact[@"byteLength"];
  if (!digest || !length) return;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSError *error = nil; NSData *bytes = STMVerifiedArtifact(digest, length, &error);
    NSString *failure = nil;
    uint32_t count = 0;
    if (bytes.length >= 84) memcpy(&count, (const char *)bytes.bytes + 80, 4);
    if (!bytes || count == 0 || count > 500000 || bytes.length != 84ULL + 50ULL * count) failure = @"The design file could not be rendered as a binary STL mesh.";
    NSMutableData *vertices = [NSMutableData data];
    NSMutableData *normals = [NSMutableData data];
    SCNVector3 minimum = SCNVector3Make(INFINITY, INFINITY, INFINITY), maximum = SCNVector3Make(-INFINITY, -INFINITY, -INFINITY);
    for (uint32_t i = 0; !failure && i < count; i++) {
      SCNVector3 triangle[3];
      for (int j = 0; j < 3; j++) {
        float coords[3]; memcpy(coords, (const char *)bytes.bytes + 84 + i * 50 + 12 + j * 12, 12);
        if (!std::isfinite(coords[0]) || !std::isfinite(coords[1]) || !std::isfinite(coords[2])) { failure = @"The mesh contains invalid coordinates."; break; }
        triangle[j] = SCNVector3Make(coords[0], coords[1], coords[2]);
        minimum.x = fminf(minimum.x, coords[0]); minimum.y = fminf(minimum.y, coords[1]); minimum.z = fminf(minimum.z, coords[2]);
        maximum.x = fmaxf(maximum.x, coords[0]); maximum.y = fmaxf(maximum.y, coords[1]); maximum.z = fmaxf(maximum.z, coords[2]);
      }
      if (failure) break;
      SCNVector3 a = triangle[0], b = triangle[1], c = triangle[2];
      double ux = b.x-a.x, uy=b.y-a.y, uz=b.z-a.z, vx=c.x-a.x, vy=c.y-a.y, vz=c.z-a.z;
      double area = hypot(hypot(uy*vz-uz*vy, uz*vx-ux*vz), ux*vy-uy*vx);
      if (!std::isfinite(area) || area == 0) { failure = @"The mesh contains an invalid triangle."; break; }
      [vertices appendBytes:triangle length:sizeof(triangle)];
      SCNVector3 normal = SCNVector3Make((uy*vz-uz*vy)/area,(uz*vx-ux*vz)/area,(ux*vy-uy*vx)/area);
      SCNVector3 faceNormals[3] = {normal,normal,normal};
      [normals appendBytes:faceNormals length:sizeof(faceNormals)];
    }
    float extent = fmaxf(fmaxf(maximum.x-minimum.x, maximum.y-minimum.y), maximum.z-minimum.z);
    if (!failure && (!std::isfinite(extent) || extent <= 0 || extent > 1000000)) failure = @"The mesh dimensions cannot be displayed.";
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self.loadSequence != sequence) return;
      if (failure) { if (self.onFailure) self.onFailure(@{@"message":failure}); return; }
      SCNGeometrySource *source = [SCNGeometrySource geometrySourceWithData:vertices semantic:SCNGeometrySourceSemanticVertex vectorCount:count*3 floatComponents:YES componentsPerVector:3 bytesPerComponent:sizeof(float) dataOffset:0 dataStride:sizeof(SCNVector3)];
      SCNGeometrySource *normalSource = [SCNGeometrySource geometrySourceWithData:normals semantic:SCNGeometrySourceSemanticNormal vectorCount:count*3 floatComponents:YES componentsPerVector:3 bytesPerComponent:sizeof(float) dataOffset:0 dataStride:sizeof(SCNVector3)];
      SCNGeometryElement *element = [SCNGeometryElement geometryElementWithData:nil primitiveType:SCNGeometryPrimitiveTypeTriangles primitiveCount:count bytesPerIndex:sizeof(uint32_t)];
      SCNGeometry *geometry = [SCNGeometry geometryWithSources:@[source,normalSource] elements:@[element]];
      SCNMaterial *material = [SCNMaterial material]; material.diffuse.contents = [UIColor colorWithRed:.48 green:.64 blue:.52 alpha:1]; material.doubleSided = YES; material.lightingModelName = SCNLightingModelBlinn;
      geometry.materials = @[material];
      SCNScene *scene = [SCNScene scene];
      SCNNode *ambient = [SCNNode node]; ambient.light = [SCNLight light]; ambient.light.type = SCNLightTypeAmbient; ambient.light.intensity = 300; [scene.rootNode addChildNode:ambient];
      SCNNode *key = [SCNNode node]; key.light = [SCNLight light]; key.light.type = SCNLightTypeOmni; key.light.intensity = 1000; key.position = SCNVector3Make(-extent, -extent*.5, extent*2); [scene.rootNode addChildNode:key];
      [scene.rootNode addChildNode:[SCNNode nodeWithGeometry:geometry]];
      SCNVector3 center = SCNVector3Make((minimum.x+maximum.x)/2, (minimum.y+maximum.y)/2, (minimum.z+maximum.z)/2);
      SCNNode *camera = [SCNNode node]; camera.camera = [SCNCamera camera]; camera.camera.screenSpaceAmbientOcclusionIntensity = 1.5; camera.camera.screenSpaceAmbientOcclusionRadius = extent*.08; camera.camera.zNear = extent*.001; camera.camera.zFar = extent*20;
      camera.position = SCNVector3Make(center.x+extent*.85, center.y-extent*.95, center.z+extent*.95);
      [camera lookAt:center up:SCNVector3Make(0,0,1) localFront:SCNVector3Make(0,0,-1)];
      [scene.rootNode addChildNode:camera]; self.scene = scene; self.pointOfView = camera;
      self.defaultCameraController.target = center;
      if (self.onReady) self.onReady(@{@"sha256":digest, @"triangleCount":@(count), @"widthMm":@(maximum.x-minimum.x), @"depthMm":@(maximum.y-minimum.y), @"heightMm":@(maximum.z-minimum.z)});
    });
  });
}
@end
@interface ArtifactMeshViewManager : RCTViewManager
@end
@implementation ArtifactMeshViewManager
RCT_EXPORT_MODULE(ArtifactMeshView)
- (UIView *)view { return [ArtifactMeshView new]; }
RCT_EXPORT_VIEW_PROPERTY(artifact, NSDictionary)
RCT_EXPORT_VIEW_PROPERTY(onReady, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onFailure, RCTDirectEventBlock)
@end

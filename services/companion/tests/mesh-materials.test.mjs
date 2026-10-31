import {test} from 'node:test';
import assert from 'node:assert/strict';
import {materialLibrary,meshTextLines,textureMap} from '../dist/mesh-materials.js';

test('mtllib keeps the whole filename, spaces included',()=>{
 assert.equal(materialLibrary('mtllib mesh.mtl'),'mesh.mtl');
 assert.equal(materialLibrary('mtllib my scan.mtl'),'my scan.mtl');
 assert.equal(materialLibrary('mtllib'),'');
 assert.equal(materialLibrary('usemtl material_0'),undefined);
});

test('texture maps: options first, then a filename that may contain spaces',()=>{
 assert.deepEqual(textureMap('map_Kd base color.png'),{directive:'map_Kd',options:[],file:'base color.png'});
 assert.deepEqual(textureMap('map_Kd -clamp off base color.png'),{directive:'map_Kd',options:['-clamp','off'],file:'base color.png'});
 assert.deepEqual(textureMap('map_Kd -clamp on mesh_basecolor_0.png'),{directive:'map_Kd',options:['-clamp','on'],file:'mesh_basecolor_0.png'});
 assert.deepEqual(textureMap('map_Bump -bm 1.000000 mesh_normal_0.png'),{directive:'map_Bump',options:['-bm','1.000000'],file:'mesh_normal_0.png'});
 // -o/-s/-t take one to three numbers; a numeric-looking filename is still the filename.
 assert.deepEqual(textureMap('map_Kd -o 0.5 0.5 1.png'),{directive:'map_Kd',options:['-o','0.5','0.5'],file:'1.png'});
 assert.deepEqual(textureMap('map_Kd -s 1 1 1 -mm 0 1 rough  map.png'),{directive:'map_Kd',options:['-s','1','1','1','-mm','0','1'],file:'rough  map.png'});
 assert.equal(textureMap('map_Kd -clamp off'),undefined);
 assert.equal(textureMap('map_Kd -unknown x.png'),undefined);
 assert.equal(textureMap('newmtl material_0'),undefined);
});

test('lines follow the mesh tools: splitlines boundaries, trimmed, comments dropped',()=>{
 assert.deepEqual([...meshTextLines(Buffer.from('# c\r\nmtllib a.mtl\r\n\n  v 0 0 0  \vusemtl m f 1 2 3'))],['mtllib a.mtl','v 0 0 0','usemtl m','f 1 2 3']);
 assert.deepEqual([...meshTextLines(undefined)],[]);
});

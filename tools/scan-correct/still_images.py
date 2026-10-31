# SPDX-License-Identifier: GPL-3.0-or-later
"""Companion still normalization; filenames and sidecars are not image authority."""
import base64
import hashlib
from io import BytesIO
import math
from pathlib import Path

MAX_SOURCE_BYTES=25*1024*1024
# Portable base64 budget: below direct Claude's 10 MB and managed endpoints' 5 MB.
# Four attached stills then use at most 20 MB of the standard 32 MB request budget.
MAX_ENCODED_BYTES=5_000_000
MAX_IMAGE_BYTES=MAX_ENCODED_BYTES//4*3
MAX_EDGE=8000
HEIC_BRANDS={b'heic',b'heix',b'heim',b'heis',b'hevc',b'hevm',b'hevs',b'mif1',b'mif2'}


def sniff(raw):
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):return 'image/png'
    if raw.startswith(b'\xff\xd8\xff'):return 'image/jpeg'
    if raw[:4]==b'RIFF' and raw[8:12]==b'WEBP':return 'image/webp'
    if raw[4:8]==b'ftyp' and (raw[8:12] in HEIC_BRANDS or any(raw[i:i+4] in HEIC_BRANDS for i in range(16,min(len(raw),64),4))):
        return 'image/heic'
    raise ValueError('detail still bytes are not PNG/JPEG/WebP/HEIC')


def prepare_still(path):
    path=Path(path)
    if not path.is_file():raise ValueError('detail still must be an image file')
    with path.open('rb') as stream:raw=stream.read(MAX_SOURCE_BYTES+1)
    if len(raw)>MAX_SOURCE_BYTES:raise ValueError('detail still exceeds companion limit of 25 MiB')
    mime=sniff(raw)
    try:
        from PIL import Image,ImageOps
    except ImportError:
        raise ValueError('image normalization needs tools/scan-correct/requirements.txt') from None
    if mime=='image/heic':
        try:
            import pillow_heif
        except ImportError:
            raise ValueError('HEIC decoding needs tools/scan-correct/requirements.txt') from None
        pillow_heif.register_heif_opener()
    try:
        with Image.open(BytesIO(raw)) as original:
            original.load()
            size=list(original.size)
            orientation=original.getexif().get(274,1)
            image=ImageOps.exif_transpose(original)
            operations=[]
            if orientation not in (None,1):operations.append('apply EXIF orientation')
            if mime=='image/heic':operations.append('HEIC to JPEG')
            resize=max(image.size)>MAX_EDGE or len(raw)>MAX_IMAGE_BYTES
            if resize:
                factor=min(1,MAX_EDGE/max(image.size),.9*math.sqrt(MAX_IMAGE_BYTES/len(raw)))
                image=image.resize((max(1,int(image.width*factor)),max(1,int(image.height*factor))),Image.Resampling.LANCZOS)
                operations.append('downscale to provider byte/dimension budget')
            sent=raw
            sent_mime=mime
            if operations:
                if image.mode in ('RGBA','LA') or 'transparency' in image.info:
                    rgba=image.convert('RGBA');rgb=Image.new('RGB',image.size,'white');rgb.paste(rgba,mask=rgba.getchannel('A'));image=rgb
                else:image=image.convert('RGB')
                for attempt in range(16):
                    buffer=BytesIO();image.save(buffer,format='JPEG',quality=90,optimize=True)
                    sent=buffer.getvalue()
                    if len(sent)<=MAX_IMAGE_BYTES:break
                    factor=min(.85,.9*math.sqrt(MAX_IMAGE_BYTES/len(sent)))
                    image=image.resize((max(1,int(image.width*factor)),max(1,int(image.height*factor))),Image.Resampling.LANCZOS)
                    if 'downscale to provider byte/dimension budget' not in operations:operations.append('downscale to provider byte/dimension budget')
                else:raise ValueError('unable to normalize detail still to provider budget')
                sent_mime='image/jpeg'
            encoded=base64.b64encode(sent).decode()
            if len(encoded)>MAX_ENCODED_BYTES:raise ValueError('normalized image exceeds provider budget')
            metadata={'sourceSha256':hashlib.sha256(raw).hexdigest(),'sourceBytes':len(raw),'sourceMediaType':mime,
                      'sourceSizePx':size,'mediaType':sent_mime,'sizePx':list(image.size),'normalization':operations,
                      'encodedByteLimit':MAX_ENCODED_BYTES}
            return {'image':(sent_mime,encoded),'source':raw,'metadata':metadata}
    except (OSError,SyntaxError,Image.DecompressionBombError) as exc:
        raise ValueError('detail still image decoding failed') from None

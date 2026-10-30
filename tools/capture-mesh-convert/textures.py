"""Small, explicit USD Preview Surface / OBJ base-colour bridge."""
import io
import math
import re


class UnsupportedTexture(RuntimeError):
    pass


def _source(inp, shader_id, output=None):
    source = inp.GetConnectedSource() if inp else None
    if not source:
        raise UnsupportedTexture("missing shader connection")
    from pxr import UsdShade
    shader = UsdShade.Shader(source[0].GetPrim())
    if not shader or shader.GetIdAttr().Get() != shader_id or (output and source[1] != output):
        raise UnsupportedTexture(f"expected {shader_id} {output or ''} connection")
    return shader


def _value(inp):
    """Follow literal material interface inputs, never evaluate shader code."""
    from pxr import UsdShade
    for _ in range(8):
        if not inp:
            return None
        if inp.GetAttr().GetNumTimeSamples():
            raise UnsupportedTexture("time-sampled base-colour graph")
        source = inp.GetConnectedSource()
        if not source:
            return inp.Get()
        if source[2] != UsdShade.AttributeType.Input:
            raise UnsupportedTexture("computed material interface value")
        inp = source[0].GetInput(source[1])
    raise UnsupportedTexture("material interface connection cycle/depth")


def base_colour(prim, src, read_asset):
    """Return material descriptor or None. Unsupported graphs must be reported."""
    from pxr import UsdShade
    material, _ = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()
    if UsdShade.MaterialBindingAPI(prim).GetMaterialBindSubsets():
        raise UnsupportedTexture("per-face material subsets are not exported")
    if not material:
        return None
    surface = _source(material.GetSurfaceOutput(), "UsdPreviewSurface", "surface")
    diffuse = surface.GetInput("diffuseColor")
    source = diffuse.GetConnectedSource() if diffuse else None
    if not source or source[2] == UsdShade.AttributeType.Input:
        colour = _value(diffuse)
        colour = tuple(colour) if colour is not None else (.18, .18, .18)
        if len(colour) != 3 or not all(math.isfinite(v) for v in colour):
            raise RuntimeError("non-finite base colour")
        return {"colour":colour, "materialPrim":str(material.GetPath())}
    texture = _source(diffuse, "UsdUVTexture", "rgb")
    for name, default in (("scale", (1,1,1,1)), ("bias", (0,0,0,0))):
        inp = texture.GetInput(name)
        if inp and (inp.HasConnectedSource() or (inp.Get() is not None and tuple(inp.Get()) != default)):
            raise UnsupportedTexture(f"texture {name} is not identity")
    reader = _source(texture.GetInput("st"), "UsdPrimvarReader_float2", "result")
    varname = reader.GetInput("varname")
    uv_name = _value(varname)
    if not uv_name:
        raise UnsupportedTexture("UV reader requires a literal primvar name")
    colour_space = _value(texture.GetInput("sourceColorSpace"))
    if colour_space not in (None, "auto", "sRGB"):
        raise UnsupportedTexture("linear/raw texture colour space cannot be represented in MTL")
    file_input = texture.GetInput("file")
    asset = file_input.Get() if file_input else None
    if not asset or file_input.HasConnectedSource() or not asset.resolvedPath:
        raise RuntimeError("texture asset is missing or unresolved")
    # This reuses the converter's source-package boundary, never a raw filesystem read.
    asset_name, data = read_asset(src, asset.resolvedPath)
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError("texture decoding requires Pillow (pip install Pillow)") from exc
    with Image.open(io.BytesIO(data)) as image:
        image.load()  # Validate even a PNG before preserving its exact bytes.
        size, image_format = image.size, image.format
        if image_format != "PNG":
            buffer = io.BytesIO()
            image.convert("RGBA" if "A" in image.getbands() else "RGB").save(buffer, format="PNG")
            data = buffer.getvalue()
    wrap = []
    for name in ("wrapS", "wrapT"):
        inp = texture.GetInput(name)
        value = inp.Get() if inp else None
        if inp and inp.HasConnectedSource():
            raise UnsupportedTexture("connected texture wrapping")
        wrap.append(value or "repeat")
    if wrap not in (["repeat", "repeat"], ["clamp", "clamp"]):
        raise UnsupportedTexture(f"unsupported texture wrapping {wrap}")
    for shader in (surface, texture, reader):
        if any(i.GetAttr().GetNumTimeSamples() for i in shader.GetInputs()):
            raise UnsupportedTexture("time-sampled base-colour graph")
    return {"colour":(1,1,1), "materialPrim":str(material.GetPath()),
            "uvPrimvar":str(uv_name), "png":data, "sourceAsset":asset_name,
            "imageSize":list(size), "sourceFormat":image_format,
            "clamp":wrap[0] == "clamp"}


def uv_coordinates(prim, name, counts, indices, point_count):
    """Expand indexed/inherited UVs, preserving the authored face-corner order."""
    from pxr import UsdGeom
    pv = UsdGeom.PrimvarsAPI(prim).FindPrimvarWithInheritance(name)
    if not pv or not pv.HasValue():
        return None
    if pv.GetElementSize() != 1:
        raise RuntimeError("UV elementSize must be 1")
    if pv.GetAttr().GetNumTimeSamples() or pv.GetIndicesAttr().GetNumTimeSamples():
        raise UnsupportedTexture("time-sampled UV primvar")
    values = pv.ComputeFlattened()
    mode = str(pv.GetInterpolation())
    expected = {"constant":1, "uniform":len(counts), "vertex":point_count,
                "varying":point_count, "faceVarying":len(indices)}
    if mode not in expected or values is None or len(values) != expected[mode]:
        raise RuntimeError(f"invalid UV cardinality/interpolation: {mode}")
    if any(len(v) != 2 or not all(math.isfinite(x) for x in v) for v in values):
        raise RuntimeError("UVs must be finite float2 values")
    result = []
    for fi, count in enumerate(counts):
        for vi in indices[len(result):len(result)+count]:
            i = {"constant":0,"uniform":fi,"vertex":vi,"varying":vi,
                 "faceVarying":len(result)}[mode]
            result.append(tuple(values[i]))
    return result


def safe_stem(path):
    return re.sub(r"[^A-Za-z0-9_-]", "_", path.stem) or "capture"

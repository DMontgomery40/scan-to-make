# Template catalog validator (support folder, not a template)

[`../catalog.json`](../catalog.json) lists every template under `tools/templates`
with its input kind, runtime, licence, CI workflow and parameter schema (name,
type, units, default, min/max, description). Folders starting with `_` are
support folders and are listed under `supportFolders`.

```sh
python3 tools/templates/_catalog/validate_catalog.py
python3 -m unittest discover -s tools/templates/_catalog/tests -v
```

Static checks need no Blender. They compare template folders against catalogue
entries, and the entrypoint, GPL `LICENSE` and SPDX header, and workflow coverage. For CLI templates
they read argparse flags, types, defaults and choices, plus any `LIMITS` table, with `ast`.
For FitSpec templates they compare `DIM_KEYS`/`PARAMETER_KEYS`
and the contract fixture defaults.

Behavioural checks run each CLI with `BLENDER` pointing nowhere. Defaults must
pass validation, and every value just past a catalogued bound must be rejected
before Blender is looked up. FitSpec `sizing()` must reject out-of-range
dimensions. Relational limits, such as wall ≥ 2 × grid, are described in the
parameter text rather than encoded as min/max.

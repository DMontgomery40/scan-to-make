"""Blender startup script: enable the user's Blender MCP addon and start its server.

Launched by the Scan to Make companion as
  open -g -j -n -a Blender --args --python start_blender_mcp.py
so the printer MCP's Blender bridge has a running Blender to talk to. The addon
is found by its registered name, whatever file name the user installed it under.
"""
import addon_utils
import bpy

PORT = 9876


def _mcp_addon_module():
    for module in addon_utils.modules():
        info = getattr(module, "bl_info", {}) or {}
        if "mcp" in str(info.get("name", "")).lower():
            return module.__name__
    return "addon"


def _start():
    try:
        addon_utils.enable(_mcp_addon_module(), default_set=True, persistent=True)
        bpy.context.scene.blendermcp_port = PORT
        bpy.ops.blendermcp.start_server()
        print("BLENDERMCP_STARTED", flush=True)
    except Exception as error:  # Reported to the companion through the port never opening.
        print("BLENDERMCP_START_FAILED", error, flush=True)
    return None


bpy.app.timers.register(_start, first_interval=2.0)

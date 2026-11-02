"""Blender startup script: enable the user's Blender MCP addon and start its server.

Launched by the Scan to Make companion as
  open -g -j -n -a Blender --args --python start_blender_mcp.py
so the printer MCP's Blender bridge has a running Blender to talk to. The addon
is found by its registered name, whatever file name the user installed it under.
"""
import addon_utils
import bpy

PORT = 9876
# Marks this Blender as launched by Scan to Make, so each touch-up may clear it fully.
bpy.app.driver_namespace["scan_to_make_owned"] = True


def _mcp_addon_module():
    for module in addon_utils.modules():
        info = getattr(module, "bl_info", {}) or {}
        if "mcp" in str(info.get("name", "")).lower():
            return module.__name__
    return "addon"


def _start():
    try:
        module = _mcp_addon_module()
        # Recent addons auto-start before this delayed callback. Re-enabling an
        # enabled addon unregisters it and disconnects an already admitted pass.
        if not addon_utils.check(module)[1]:
            addon_utils.enable(module, default_set=True, persistent=True)
        bpy.context.scene.blendermcp_port = PORT
        server = getattr(bpy.types, "blendermcp_server", None)
        if server and server.port != PORT:
            # A saved scene may auto-start on a different port. This marked
            # helper has not admitted a pass on PORT yet; retarget only its server.
            if server.running:
                server.stop()
            server.port = PORT
        if not server or not server.running:
            bpy.ops.blendermcp.start_server()
        print("BLENDERMCP_STARTED", flush=True)
    except Exception as error:  # Reported to the companion through the port never opening.
        print("BLENDERMCP_START_FAILED", error, flush=True)
    return None


bpy.app.timers.register(_start, first_interval=2.0)

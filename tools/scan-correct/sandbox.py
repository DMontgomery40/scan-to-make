# SPDX-License-Identifier: GPL-3.0-or-later
"""OS-enforced worker network isolation, inherited across exec; fail closed."""
import ctypes
import ctypes.util
import errno
import os
import sys


MACOS_SANDBOX = '/usr/bin/sandbox-exec'
# Block IP network traffic (including loopback) for the worker and
# its descendants. Filesystem and Mach access retain the existing trusted-code
# boundary; the host adapter stays outside this sandbox so it can call models.
MACOS_PROFILE = '(version 1)(allow default)(deny network*)'


def isolate():
    if sys.platform != 'linux':
        raise RuntimeError('network isolation requires Linux and libseccomp')
    path = ctypes.util.find_library('seccomp')
    if not path:
        raise RuntimeError('libseccomp absent')
    lib = ctypes.CDLL(path, use_errno=True)
    class Compare(ctypes.Structure):
        _fields_ = [('arg',ctypes.c_uint),('op',ctypes.c_int),
                    ('a',ctypes.c_uint64),('b',ctypes.c_uint64)]
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,
                                          ctypes.c_uint,ctypes.POINTER(Compare)]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not ctx:
        raise RuntimeError('seccomp init failed')
    try:
        # AF_UNIX is retained for local Blender/Xvfb IPC; all other socket domains denied.
        for name in ('socket','socketpair'):
            syscall = lib.seccomp_syscall_resolve_name(name.encode())
            cmp = Compare(0,1,1,0)  # SCMP_CMP_NE, domain != AF_UNIX
            if syscall < 0 or lib.seccomp_rule_add_array(ctx,0x50000|errno.EPERM,syscall,1,ctypes.byref(cmp)):
                raise RuntimeError('seccomp socket rule failed')
        for name in ('socketcall','io_uring_setup'):
            syscall = lib.seccomp_syscall_resolve_name(name.encode())
            if syscall >= 0 and lib.seccomp_rule_add_array(ctx,0x50000|errno.EPERM,syscall,0,None):
                raise RuntimeError('seccomp bypass rule failed')
        if lib.seccomp_load(ctx):
            raise RuntimeError('seccomp load failed')
    finally:
        lib.seccomp_release(ctx)


def main(command):
    if not command:
        raise ValueError('worker executable required')
    if sys.platform == 'darwin':
        # exec replaces the launcher: deadlines still target the same process
        # group. A missing executable or rejected profile cannot run the worker.
        os.execv(MACOS_SANDBOX, [MACOS_SANDBOX, '-p', MACOS_PROFILE, *command])
    elif sys.platform == 'linux':
        isolate()
        os.execv(command[0], command)
    else:
        raise RuntimeError('unsupported platform for worker network isolation')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as exc:
        print('network sandbox failed: '+str(exc),file=sys.stderr)
        sys.exit(2)

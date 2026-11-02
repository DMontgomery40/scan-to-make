"""Cases for check-lidar-sync.py: python3 -m unittest discover -s apps/mobile/ios/scripts -p 'test_*.py'"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("check-lidar-sync.py")
OPEN = "22:10:01.612095 ScanToMake{AVFCapture}[478] <NOTICE>: -[AVCaptureSession addInput:]: <AVCaptureDeviceInput: 0x2 [Back LiDAR Depth Camera]>"
START = "22:10:30.000000 ScanToMake{AVFCapture}[478] <NOTICE>: -[AVCaptureSession startRunning]: (0x3)"
STOP = "22:10:10.000000 cameracaptured{CMCapture}[73] <NOTICE>: captureSession_StopRunning: <0x7[478][com.scantomake]> Called"
STOP2 = "22:10:50.000000 cameracaptured{CMCapture}[73] <NOTICE>: captureSession_StopRunning: <0x8[478][com.scantomake]> Called"
IN_USE = "22:10:05.788000 cameracaptured{CMCapture}[73] <NOTICE>: copyDeviceWithID: Device 0x7476 is use by <BWFigCaptureDeviceClient: 0x1 clientID: 6, pid: 478, clientApplicationID: com.scantomake, clientPriority: High"
REFUSED = '22:10:05.788033 cameracaptured{CMCapture}[73] <ERROR>: Fig assert: "err == 0 " at bail (FigCaptureSession.m:15248) - (err=-12681)'
FACE_ID_TEARDOWN = "22:10:05.788046 cameracaptured{CMCapture}[73] <NOTICE>: captureSession_buildGraphWithConfiguration: <0x9[134][com.apple.biometrickitd]> Tearing down graph to recover from err (-12681) during graph build"
IN_USE2 = "22:10:35.000000 cameracaptured{CMCapture}[73] <NOTICE>: copyDeviceWithID: Device 0x7476 is use by <BWFigCaptureDeviceClient: 0x1 clientID: 6, pid: 478, clientApplicationID: com.scantomake, clientPriority: High"
REFUSED2 = "22:10:35.000100 cameracaptured{CMCapture}[73] <ERROR>: captureSession_commitInflightConfiguration: <0x9[134][com.apple.biometrickitd]> error (-12681) building graph with configuration"
OURS_FAILS = "22:10:05.789000 cameracaptured{CMCapture}[73] <ERROR>: captureSession_commitInflightConfiguration: <0x7[478][com.scantomake]> error (-12681) building graph with configuration"
SOMEONE_ELSE_IN_USE = "22:10:05.788000 cameracaptured{CMCapture}[73] <NOTICE>: copyDeviceWithID: Device 0x7476 is use by <BWFigCaptureDeviceClient: 0x1 clientID: 6, pid: 579, clientApplicationID: com.apple.camera, clientPriority: High"
FACE_ID = "22:10:20.000000 cameracaptured{CMCapture}[73] <ERROR>: captureSession_commitInflightConfiguration: <0x9[134][com.apple.biometrickitd]> error (-12681) building graph with configuration"
CAMERA_NOTICE = "22:10:21.000000 cameracaptured{H16ISP.mediacapture}[73] <NOTICE>: H16ISPCaptureStreamSetProperty - Error setting ExternalSyncFrameRateRational <private>: -12684"
PULSE = "22:10:21.000100 cameracaptured{H16ISP.mediacapture}[73] <ERROR>: Cannot change the external pulse rate from the MSG after stream has started"


def check(*lines: str) -> int:
    with tempfile.TemporaryDirectory() as folder:
        log = Path(folder) / "device.log"
        log.write_text("\n".join("2026-11-01 " + line for line in lines))
        return subprocess.run([sys.executable, str(SCRIPT), str(log)], capture_output=True).returncode


class CheckLidarSync(unittest.TestCase):
    def test_face_id_refused_while_we_hold_the_camera_passes(self):
        self.assertEqual(check(OPEN, IN_USE, REFUSED, FACE_ID_TEARDOWN, STOP), 0)

    def test_our_own_graph_failing_beside_a_refusal_fails(self):
        self.assertEqual(check(OPEN, IN_USE, REFUSED, FACE_ID_TEARDOWN, OURS_FAILS, STOP), 1)

    def test_in_use_by_another_app_does_not_excuse_a_failure(self):
        self.assertEqual(check(OPEN, SOMEONE_ELSE_IN_USE, REFUSED, FACE_ID_TEARDOWN, STOP), 1)

    def test_a_failure_during_our_session_without_in_use_fails(self):
        self.assertEqual(check(OPEN, REFUSED, FACE_ID_TEARDOWN, STOP), 1)

    def test_face_id_failing_after_we_stop_fails(self):
        self.assertEqual(check(OPEN, STOP, FACE_ID), 1)

    def test_reopened_session_refusal_passes(self):
        self.assertEqual(check(OPEN, STOP, START, IN_USE2, REFUSED2, STOP2), 0)

    def test_failure_between_sessions_fails(self):
        self.assertEqual(check(OPEN, STOP, FACE_ID, START, STOP2), 1)

    def test_camera_start_notices_are_evidence_only(self):
        self.assertEqual(check(OPEN, STOP, CAMERA_NOTICE, PULSE), 0)

    def test_a_log_without_our_session_cannot_pass(self):
        self.assertEqual(check(FACE_ID), 2)


if __name__ == "__main__":
    unittest.main()

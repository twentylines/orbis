import importlib.util
import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("download_update", Path(__file__).with_name("orbis-host-update.py"))
UPDATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATE)
TARGET = {"image": "ghcr.io/twentylines/orbis", "digest": "sha256:" + "a" * 64}
SUCCESS = {"status": "Status: Downloaded newer image for ghcr.io/twentylines/orbis@" + TARGET["digest"]}


def layer(identifier, status, current=None, total=None):
    value = {"id": identifier * 12, "status": status}
    if current is not None:
        value["progressDetail"] = {"current": current, **({"total": total} if total is not None else {})}
    return value


class DownloadProgressTests(unittest.TestCase):
    def setUp(self):
        self.output = []
        self.now = 0
        self.tracker = UPDATE.DownloadProgress(self.output.append, clock=lambda: self.now, wall_clock=lambda: 123)

    def event(self, value):
        self.now += 1
        return self.tracker.event(value)

    def test_multiple_layers_cached_layers_and_extraction_have_separate_counters(self):
        self.event(layer("a", "Pulling fs layer"))
        self.event(layer("b", "Pulling fs layer"))
        self.event(layer("c", "Already exists"))
        self.event(layer("a", "Downloading", 25, 100))
        self.assertIsNone(self.output[-1]["totalBytes"])
        self.event(layer("b", "Downloading", 10, 50))
        self.assertEqual((self.output[-1]["currentBytes"], self.output[-1]["totalBytes"]), (35, 150))
        self.event(layer("a", "Downloading", 20, 100))
        self.assertEqual(self.output[-1]["currentBytes"], 35)
        self.event(layer("a", "Download complete"))
        self.event(layer("a", "Extracting", 900, 1000))
        self.assertEqual(self.output[-1]["currentBytes"], 110)
        self.assertEqual(self.output[-1]["phase"], "downloading")
        self.event(layer("b", "Download complete"))
        self.assertEqual(self.output[-1]["phase"], "extracting")
        self.event(layer("a", "Pull complete"))
        self.event(layer("b", "Pull complete"))
        self.tracker.finish()
        final = self.output[-1]
        self.assertEqual((final["phase"], final["currentBytes"], final["totalBytes"]), ("complete", 150, 150))
        self.assertFalse(final["alreadyCached"])
        self.assertEqual((final["layersComplete"], final["layersTotal"]), (3, 3))
        self.assertEqual([p["currentBytes"] for p in self.output], sorted(p["currentBytes"] for p in self.output))

    def test_total_remains_unknown_when_a_download_size_is_missing(self):
        self.event(layer("a", "Downloading", 17))
        self.event(layer("a", "Pull complete"))
        self.tracker.finish()
        self.assertEqual(self.output[-1]["currentBytes"], 17)
        self.assertIsNone(self.output[-1]["totalBytes"])
        self.assertFalse(self.output[-1]["totalKnown"])

    def test_all_cached_and_up_to_date_images_have_zero_transfer(self):
        self.event(layer("a", "Already exists"))
        self.tracker.finish()
        self.assertTrue(self.output[-1]["alreadyCached"])
        self.assertEqual(self.output[-1]["totalBytes"], 0)
        tracker = UPDATE.DownloadProgress(self.output.append)
        tracker.event({"status": "Status: Image is up to date for image"})
        tracker.finish()
        self.assertTrue(self.output[-1]["alreadyCached"])

    def test_no_per_chunk_writes_duplicate_writes_or_lost_final_counters(self):
        self.tracker.emit(force=True)
        for current in range(1000):
            self.now = current / 1000
            self.tracker.event(layer("a", "Downloading", current, 1000))
        self.assertEqual(len(self.output), 1)
        self.now = 1
        self.tracker.event(layer("a", "Downloading", 1000, 1000))
        self.now = 2
        self.tracker.event(layer("a", "Downloading", 1000, 1000))
        self.assertEqual(len(self.output), 2)
        self.tracker.event(layer("a", "Pull complete"))
        self.tracker.finish()
        self.assertEqual(self.output[-1]["currentBytes"], 1000)
        self.assertEqual(len(self.output), 3)

    def test_invalid_counters_errors_incomplete_layers_and_layer_bounds_fail_closed(self):
        for event in ({"error": "SECRET"}, {"errorDetail": {"message": "SECRET"}},
                      layer("a", "Downloading", True, 20), layer("a", "Downloading", 21, 20),
                      layer("a", "Downloading", -1, 20), layer("a", "Downloading", UPDATE.DOWNLOAD_LIMIT + 1),
                      {"status": "Downloading", "id": "../../SECRET", "progressDetail": {"current": 1}}):
            with self.subTest(event=event), self.assertRaises((ValueError, RuntimeError)) as caught:
                self.tracker.event(event)
            self.assertNotIn("SECRET", str(caught.exception))
        self.event(layer("a", "Downloading", 1, 20))
        with self.assertRaisesRegex(RuntimeError, "all layers"):
            self.tracker.finish()
        with mock.patch.object(UPDATE, "PULL_LAYER_LIMIT", 1), self.assertRaises(ValueError):
            self.event(layer("b", "Pulling fs layer"))

    def test_only_valid_bounded_public_fields_are_serialized(self):
        self.event(layer("a", "Already exists"))
        self.tracker.finish()
        progress = self.output[-1]
        self.assertEqual(UPDATE.safe_download({"download": progress}), {"download": progress})
        for value in ({**progress, "path": "SECRET"}, {**progress, "currentBytes": True},
                      {**progress, "totalBytes": None}, {**progress, "updatedAt": float("nan")},
                      {**progress, "layersTotal": 5000}, {**progress, "phase": "SECRET"}, {**progress, "phase": []}):
            self.assertEqual(UPDATE.safe_download({"download": value}), {})


class UnixHTTPServer(HTTPServer):
    address_family = socket.AF_UNIX

    def server_bind(self):
        self.socket.bind(self.server_address)
        self.server_name, self.server_port = "localhost", 0


class DownloadStreamTests(unittest.TestCase):
    def stream(self, body, *, cancelled=None, status=200):
        observed = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                observed.append(self.path)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                try:
                    for offset in range(0, len(body), 37):
                        block = body[offset:offset + 37]
                        self.wfile.write(f"{len(block):x}\r\n".encode() + block + b"\r\n")
                        self.wfile.flush()
                    self.wfile.write(b"0\r\n\r\n")
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *_args):
                pass

        with tempfile.TemporaryDirectory(prefix="dp-") as folder:
            endpoint = str(Path(folder) / "d.sock")
            server = UnixHTTPServer(endpoint, Handler)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            output = []
            try:
                with mock.patch.object(UPDATE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps("unix://" + endpoint))):
                    UPDATE.pull_verified_image("explicit-context", TARGET, Path(folder), output.append, cancelled=cancelled)
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)
        return output, observed

    def body(self, *events):
        return b"".join(json.dumps(event).encode() + b"\n" for event in events)

    def test_real_chunked_http_stream_uses_pinned_digest_and_reports_completion(self):
        output, paths = self.stream(self.body(layer("a", "Pulling fs layer"), layer("a", "Downloading", 50, 100),
                                              layer("a", "Pull complete"), SUCCESS))
        self.assertEqual(output[-1]["currentBytes"], 100)
        self.assertEqual(output[-1]["phase"], "complete")
        self.assertEqual(paths, ["/images/create?fromImage=ghcr.io%2Ftwentylines%2Forbis&tag=sha256%3A" + "a" * 64])

    def test_error_http_failure_truncation_and_no_final_confirmation_fail(self):
        for body, status in ((self.body({"error": "SECRET"}), 200), (self.body(SUCCESS), 500),
                             (b'{"status":"incomplete"', 200), (self.body(layer("a", "Already exists")), 200),
                             (self.body(layer("a", "Downloading", 1, 2), SUCCESS), 200),
                             (self.body({"status": "Status: Image is up to date for another-image"}), 200)):
            with self.subTest(body=body, status=status), self.assertRaises((ValueError, RuntimeError)) as caught:
                self.stream(body, status=status)
            self.assertNotIn("SECRET", str(caught.exception))

    def test_cancellation_timeout_and_stream_limits_never_report_completion(self):
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            self.stream(self.body(SUCCESS), cancelled=lambda: True)
        with mock.patch.object(UPDATE, "PULL_TIMEOUT", 0), self.assertRaisesRegex(RuntimeError, "timed out"):
            self.stream(self.body(SUCCESS))
        with mock.patch.object(UPDATE, "PULL_STREAM_LIMIT", 5), self.assertRaisesRegex(ValueError, "size limit"):
            self.stream(self.body(SUCCESS))
        with mock.patch.object(UPDATE, "PULL_LINE_LIMIT", 5), self.assertRaisesRegex(ValueError, "limit"):
            self.stream(self.body(SUCCESS))

    def test_total_deadline_and_cancellation_interrupt_a_stalled_http_header(self):
        for timeout, cancelled in ((0.05, None), (10, lambda: True)):
            aborted = threading.Event()
            connection = mock.Mock()
            connection.transport.shutdown.side_effect = lambda *_: aborted.set()
            def stalled_response():
                self.assertTrue(aborted.wait(1), "the hard deadline did not interrupt the transport")
                raise UPDATE.http.client.RemoteDisconnected("synthetic stalled response")
            connection.getresponse.side_effect = stalled_response
            started = time.monotonic()
            with mock.patch.object(UPDATE, "PULL_TIMEOUT", timeout), \
                    mock.patch.object(UPDATE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps("unix:///explicit.sock"))), \
                    mock.patch.object(UPDATE, "DownloadConnection", return_value=connection):
                with self.assertRaises(RuntimeError):
                    UPDATE.pull_verified_image("explicit", TARGET, Path.cwd(), lambda _: None, cancelled=cancelled)
            self.assertLess(time.monotonic() - started, 0.8)
            connection.close_transport.assert_called_once()

    def test_remote_context_uses_docker_transport_with_its_exact_context(self):
        connection = UPDATE.DownloadConnection("ssh://other", "remote-exact", Path.cwd())
        process = mock.Mock()
        with mock.patch.object(UPDATE.subprocess, "Popen", return_value=process) as launch:
            connection.connect()
            self.assertEqual(launch.call_args.args[0], ["docker", "--context", "remote-exact", "system", "dial-stdio"])
            self.assertIs(launch.call_args.kwargs["stdin"], launch.call_args.kwargs["stdout"])
            self.assertTrue(launch.call_args.kwargs["start_new_session"])
            connection.close_transport()
        process.wait.assert_called_once_with(timeout=1)

    def test_remote_transport_consumes_the_body_after_connection_close_headers(self):
        body = self.body(layer("a", "Already exists"), SUCCESS)
        script = (
            "import os,time\n"
            "request=b''\n"
            "while b'\\r\\n\\r\\n' not in request: request+=os.read(0,4096)\n"
            f"body={body!r}\n"
            "os.write(1,b'HTTP/1.1 200 OK\\r\\nConnection: close\\r\\nContent-Length: '+str(len(body)).encode()+b'\\r\\n\\r\\n')\n"
            "for offset in range(0,len(body),13):\n"
            " os.write(1,body[offset:offset+13]); time.sleep(0.005)\n"
        )
        launch = subprocess.Popen
        processes = []
        def proxy(command, **kwargs):
            self.assertEqual(command, ["docker", "--context", "remote-exact", "system", "dial-stdio"])
            process = launch([sys.executable, "-c", script], **kwargs)
            processes.append(process)
            return process
        output = []
        with mock.patch.object(UPDATE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps("ssh://selected"))), \
                mock.patch.object(UPDATE.subprocess, "Popen", side_effect=proxy):
            UPDATE.pull_verified_image("remote-exact", TARGET, Path.cwd(), output.append)
        self.assertEqual(output[-1]["phase"], "complete")
        self.assertTrue(output[-1]["alreadyCached"])
        self.assertEqual([process.poll() for process in processes], [0])

    def test_remote_transport_is_terminated_and_reaped_when_it_does_not_exit(self):
        connection = UPDATE.DownloadConnection("tcp://other", "tls-context", Path.cwd())
        process = mock.Mock(pid=123)
        process.wait.side_effect = [subprocess.TimeoutExpired("docker", 1), subprocess.TimeoutExpired("docker", 2), 0]
        with mock.patch.object(UPDATE.subprocess, "Popen", return_value=process), mock.patch.object(UPDATE.os, "killpg") as kill:
            connection.connect()
            connection.close_transport()
        self.assertEqual(kill.call_args_list, [mock.call(123, UPDATE.signal.SIGTERM), mock.call(123, UPDATE.signal.SIGKILL)])
        self.assertEqual(process.wait.call_count, 3)


if __name__ == "__main__":
    unittest.main()

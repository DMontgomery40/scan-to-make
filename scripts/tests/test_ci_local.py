import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1]/'ci_local.py'
spec = importlib.util.spec_from_file_location('ci_local', MODULE)
ci = importlib.util.module_from_spec(spec); spec.loader.exec_module(ci)
ROOT = MODULE.parents[1]


class LocalWorkflowTests(unittest.TestCase):
    def test_workflows_and_reviews_reject_tracked_or_untracked_changes(self):
        for mode in ('all', 'review'):
            for status in (' M tracked.py', '?? new-fixture.py'):
                with self.subTest(mode=mode, status=status), \
                     patch.object(sys, 'argv', ['ci_local.py', mode]), \
                     patch.object(ci, 'output', side_effect=[str(ROOT), 'head-sha', status]) as output, \
                     patch.object(ci, 'reviews') as review:
                    with self.assertRaisesRegex(ValueError, 'Commit'):
                        ci.main()
                    review.assert_not_called()
                    self.assertIn('--untracked-files=all', output.call_args.args[0])

    def test_xcode_image_labels_run_on_the_mac_like_macos_labels(self):
        for label in ('macos-15', 'xcode-27'):
            spec={'workflow':'mac','key':'build','matrix':{},'job':{'runs-on':label,'steps':[]}}
            passed={'spec':spec,'status':'PASS','steps':[]}
            for system, local in (('Linux', False), ('Darwin', True)):
                with self.subTest(label=label, system=system), tempfile.TemporaryDirectory() as folder, \
                     patch.object(sys, 'argv', ['ci_local.py', 'mac', '--output', folder]), \
                     patch.object(ci, 'output', side_effect=[str(ROOT), 'head-sha', '']), \
                     patch.object(ci, 'read_workflows', return_value=[spec]), \
                     patch.object(ci.platform, 'system', return_value=system), \
                     patch.object(ci, 'run_mac', return_value=passed) as remote, \
                     patch.object(ci, 'execute_job', return_value=passed) as here:
                    self.assertEqual(ci.main(), 0)
                    (here if local else remote).assert_called_once()
                    (remote if local else here).assert_not_called()

    def test_repeated_output_preserves_old_evidence_and_uses_fresh_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            first=ci.evidence_directory(Path(folder)/'evidence')
            (first/'summary.md').write_text('previous run')
            second=ci.evidence_directory(first)
            self.assertNotEqual(first,second)
            self.assertEqual(second.parent,first)
            self.assertEqual(list(second.iterdir()),[])
            self.assertEqual((first/'summary.md').read_text(),'previous run')

    def test_mac_copy_fetches_only_logs_and_result_without_temp_dependencies(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(ci.subprocess,'run') as run:
            destination=Path(folder)/'mac'
            ci.collect_mac_evidence('mac','/private/tmp/ci-fixture',destination)
            argv=run.call_args.args[0]
            self.assertEqual(argv[0],'scp')
            self.assertNotIn('-r',argv)
            self.assertEqual(argv[1:-1],[
                'mac:/private/tmp/ci-fixture/result/result.json',
                'mac:/private/tmp/ci-fixture/result/*.log',
                'mac:/private/tmp/ci-fixture/launch.log',
                'mac:/private/tmp/ci-fixture/launch-error.log'])
            self.assertTrue(destination.is_dir())

    def test_all_real_workflows_expand_and_select_changed_paths(self):
        jobs = ci.read_workflows(ROOT, 'all')
        self.assertGreaterEqual(len(jobs), 19)
        selected = ci.read_workflows(ROOT, 'all', ['services/companion/tests/print-handoff-http.test.mjs'])
        self.assertEqual({j['workflow'] for j in selected}, {'companion', 'companion-package', 'e2e-pipeline'})
        self.assertEqual([j['matrix'] for j in selected if j['workflow']=='companion'], [{'node':22},{'node':24}])
        self.assertEqual(ci.read_workflows(ROOT, 'all', ['unrelated-note.txt']), [])
        with self.assertRaises(ValueError): ci.read_workflows(ROOT, 'compnaion', [])

    def test_path_filters_match_zero_or_many_directories_and_ordered_negation(self):
        self.assertTrue(ci.matches('package.json', '**/package.json'))
        self.assertTrue(ci.matches('apps/mobile/package.json', '**/package.json'))
        self.assertFalse(ci.matches('apps/mobile/src/a.ts', 'apps/*/a.ts'))
        patterns=['apps/**','!apps/private/**','apps/private/allowed.ts']
        self.assertFalse(ci.included('apps/private/secret.ts',patterns))
        self.assertTrue(ci.included('apps/private/allowed.ts',patterns))

    def test_unknown_expression_and_condition_fail_instead_of_silent_skip(self):
        self.assertEqual(ci.expand('v${{ matrix.node }}',{'matrix.node':22}),'v22')
        with self.assertRaises(ValueError): ci.expand('${{ secrets.SOMETHING }}',{})
        with self.assertRaises(ValueError): ci.condition('unknown()',{},False)
        self.assertTrue(ci.condition('failure()',{},True))
        self.assertFalse(ci.condition(None,{},True))
        self.assertTrue(ci.condition("steps.blender-cache.outputs.cache-hit != 'true'",{'steps.blender-cache.outputs.cache-hit':'false'},False))

    def test_steps_keep_environment_cwd_failure_handler_and_pipefail(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); (root/'sub').mkdir()
            job={'workflow':'fixture','key':'test','matrix':{},'env':{'FOO':'workflow'},'defaults':{},'job':{
                'runs-on':'ubuntu-latest','env':{'FOO':'job'},'defaults':{'run':{'working-directory':'sub'}},'steps':[
                {'run':'test "$FOO" = job; echo "NEXT=from-first" >> "$GITHUB_ENV"; printf "LONG<<EOF\\na\\nb\\nEOF\\n" >> "$GITHUB_ENV"'},
                {'run':'test "$FOO" = step; test "$NEXT" = from-first; test "$LONG" = $\'a\\nb\'; test "${PWD##*/}" = sub','env':{'FOO':'step'}},
                {'run':'false | true'},
                {'run':'touch must-not-exist'},
                {'if':'failure()','run':'touch failure-ran'},
            ]}}
            result=ci.execute_job(job,root,root/'logs')
            self.assertEqual([r['status'] for r in result['steps']],['PASS','PASS','FAIL','SKIP','PASS'])
            self.assertEqual(result['status'],'FAIL')
            self.assertFalse((root/'sub/must-not-exist').exists()); self.assertTrue((root/'sub/failure-ran').exists())
            self.assertEqual(json.loads((root/'logs/result.json').read_text())['status'],'FAIL')

    def test_unknown_action_fails_job_and_preserves_error(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            job={'workflow':'fixture','key':'test','matrix':{},'env':{},'defaults':{},'job':{'steps':[{'uses':'vendor/unknown@123'}]}}
            result=ci.execute_job(job,root,root/'logs')
            self.assertEqual(result['status'],'FAIL');self.assertIn('Unsupported action',result['steps'][0]['note'])

    def test_node_adapter_verifies_major_and_selects_requested_binary(self):
        with patch.object(ci,'output',return_value='22.23.4'),patch.object(ci.Path,'is_file',return_value=True):
            folder,note=ci.select_node(22,{'PATH':'/usr/bin','CI_LOCAL_NODE_22':'/tmp/node22/bin/node'})
            self.assertEqual(folder,'/tmp/node22/bin');self.assertIn('22.23.4',note)
        with patch.object(ci,'output',return_value='24.22.2'),patch.object(ci.Path,'is_file',return_value=True):
            with self.assertRaises(ValueError):ci.select_node(22,{'PATH':'/usr/bin'})

    def test_timeout_terminates_command_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(subprocess.TimeoutExpired):
                ci.run_command('sleep 30',Path(folder),os.environ.copy(),Path(folder)/'log',.05)

    def test_local_cache_becomes_hit_only_after_success(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); env={'CI_LOCAL_CACHE':str(root/'cache')}; context={}
            step={'uses':'actions/cache@pin','id':'pin','with':{'path':str(root/'first/blender'),'key':'version-sha256'}}
            ci.setup_action(step,context,env,root/'first')
            self.assertEqual(context['steps.pin.outputs.cache-hit'],'false')
            Path(context['_cache_markers'][0]).touch()
            step['with']['path']=str(root/'second/blender')
            ci.setup_action(step,context,env,root/'second')
            self.assertEqual(context['steps.pin.outputs.cache-hit'],'true')

    def test_review_preserves_exact_private_prompt_and_uses_another_lab(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); prompts=root/'prompts';prompts.mkdir(); logs=root/'logs';logs.mkdir()
            (prompts/'codex-review-rubric.md').write_text('Exact rubric\n')
            (prompts/'cursor-bugbot-review.md').write_text('Exact cursor prompt\n')
            with patch.object(ci,'output',return_value='diff fixture'),patch.object(ci.subprocess,'run',return_value=subprocess.CompletedProcess([],0)) as run:
                ci.reviews(root,logs,'origin/main','codex',str(prompts))
            self.assertEqual(run.call_args_list[0].args[0],['codex','review','--base','origin/main'])
            self.assertEqual(run.call_args_list[1].args[0][0],'muse')
            self.assertTrue((logs/'cursor-task.txt').read_text().startswith('Exact cursor prompt\n'))
            self.assertIn('not a clean verdict',(logs/'summary.md').read_text())

    def test_mac_job_uses_gui_launchd_and_boots_out_its_own_label(self):
        import plistlib
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); directory=root/'result'
            manifest=root/'manifest.json';manifest.write_text(json.dumps({'workspace':str(root),'directory':str(directory),'spec':{'job':{'timeout-minutes':1}}}))
            def launch(argv,**kwargs):
                if argv[1]=='bootstrap':
                    directory.mkdir();(directory/'result.json').write_text('{}')
                return subprocess.CompletedProcess(argv,0)
            with patch.object(ci.subprocess,'run',side_effect=launch) as run, \
                 patch.dict(os.environ,{'CI_LOCAL_NODE_24':'/custom/node24/bin/node',
                    'CI_LOCAL_PYTHON_3_12':'/custom/python3.12','PRIVATE_TOKEN':'never-forward'}):
                ci.mac_launch(manifest)
            calls=[call.args[0] for call in run.call_args_list]
            self.assertEqual(calls[0][:3],['launchctl','bootstrap','gui/'+str(os.getuid())])
            self.assertEqual(calls[-1][:2],['launchctl','bootout'])
            config=plistlib.loads((root/'job.plist').read_bytes())
            self.assertIn('--worker',config['ProgramArguments'])
            self.assertNotIn('Terminal',str(config))
            self.assertEqual(config['EnvironmentVariables']['CI_LOCAL_NODE_24'],'/custom/node24/bin/node')
            self.assertEqual(config['EnvironmentVariables']['CI_LOCAL_PYTHON_3_12'],'/custom/python3.12')
            self.assertNotIn('PRIVATE_TOKEN',config['EnvironmentVariables'])


if __name__=='__main__': unittest.main()

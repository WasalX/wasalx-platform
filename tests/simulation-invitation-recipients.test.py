import ast,pathlib,unittest
source=(pathlib.Path(__file__).resolve().parents[1]/'scripts/release/simulation-invitation-mail/prepare-invitation-smtps.py').read_text()
nodes=[n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name in ['controlled_recipients','validate_checkout_boundary','bind_smtp_parent']];ns={'pathlib':pathlib};exec(compile(ast.Module(body=nodes,type_ignores=[]),'guard','exec'),ns)
class Tests(unittest.TestCase):
 def test_single(self):self.assertEqual(ns['controlled_recipients']({'recipient':'synthetic@example.test'}),['synthetic@example.test'])
 def test_pair(self):self.assertEqual(len(ns['controlled_recipients']({'recipient':'synthetic@example.test','recipients':['synthetic@example.test','synthetic-isolation@example.test']})),2)
 def test_other(self):
  with self.assertRaises(AssertionError):ns['controlled_recipients']({'recipient':'synthetic@example.test','recipients':['synthetic@example.test','other@example.test']})
 def test_injection(self):
  with self.assertRaises(AssertionError):ns['controlled_recipients']({'recipient':'synthetic\n@example.test'})
 def test_checkout_roots(self):
  private=pathlib.PurePosixPath('/srv/wasalx-fast/wasalx-simulation-test')
  # These are lexical boundaries; filesystem canonicality is handled by the caller.
  with patch_path():
   for path in ['/srv/wasalx-fast/candidates/source','/srv/wasalx-fast/qualification/run/source']:
    ns['validate_checkout_boundary'](pathlib.PurePosixPath(path),private)
   for path in ['/tmp/source','/srv/wasalx-fast/qualification-other/source','/srv/wasalx-fast/qualification']:
    with self.assertRaises(AssertionError):ns['validate_checkout_boundary'](pathlib.PurePosixPath(path),private)
 def test_parent_inheritance(self):
  sink={'services':{'alpha-smtps':{'image':'unchanged','environment':{'PORT':'465'}}}}
  ns['bind_smtp_parent'](sink,{'cgroup_parent':'owned.slice'})
  self.assertEqual(sink['services']['alpha-smtps'],{'image':'unchanged','environment':{'PORT':'465'},'cgroup_parent':'owned.slice'})
  with self.assertRaises(AssertionError):ns['bind_smtp_parent'](sink,{'cgroup_parent':'foreign.slice'})
 def test_unscoped_parent_unchanged(self):
  sink={'services':{'alpha-smtps':{'image':'unchanged'}}}
  ns['bind_smtp_parent'](sink,{})
  self.assertEqual(sink,{'services':{'alpha-smtps':{'image':'unchanged'}}})
from unittest.mock import patch
def patch_path():return patch.dict(ns,{'pathlib':type('Paths',(),{'Path':pathlib.PurePosixPath})})
unittest.main()

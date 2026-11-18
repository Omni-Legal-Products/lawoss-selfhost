"""Import shim: `python3 -m unittest deploy/test/compose.test.py` imports the module
deploy.test.compose.test, so this file loads ../compose.test.py and re-exports its test cases."""
import importlib.util
import os
import unittest

_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "compose.test.py")
_spec = importlib.util.spec_from_file_location("lawoss_compose_test", _path)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
globals().update({name: value for name, value in vars(_module).items()
                  if isinstance(value, type) and issubclass(value, unittest.TestCase)})

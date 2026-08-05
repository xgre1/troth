## Python Project Rules
- Use type hints on all function signatures.
- Follow PEP 8 formatting.
- Use `pathlib.Path` for file operations instead of `os.path`.
- Use `with` statements for file/resource handling.
- Use f-strings for string formatting.

## Workflow Routine for Python Tasks
1. **Understand**: Check requirements.txt/pyproject.toml for dependencies, Python version. Check if project uses Django, Flask, FastAPI, or is vanilla.
2. **Plan**: For APIs: define routes, models, serializers. For scripts: define input/output, error handling.
3. **Implement**: Match existing patterns. Use existing base classes and utilities. Follow the project's import style.
4. **Verify**: Run `python3 -c "compile(open('<file>').read(),'<file>','exec')"` for syntax. Run `pytest` if tests exist.

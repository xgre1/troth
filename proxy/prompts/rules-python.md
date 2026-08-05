# Python Rules (in-context)

You are working with Python code. Apply these rules:

- Use type hints on all function signatures: `def foo(x: int, y: str) -> bool:`.
- Prefer `pathlib.Path` over `os.path` for file paths.
- Use context managers (`with`) for files, locks, DB connections — never raw `open()`.
- f-strings for formatting, never `%` or `.format()`.
- For data classes, use `@dataclass` (or `pydantic.BaseModel` if validation needed), never raw classes.
- `enumerate()` instead of `range(len(...))`.
- Comprehensions for simple maps/filters, generator expressions for streams.
- Specific exceptions, never bare `except:` — `except Exception as e:` at minimum.
- Async: use `asyncio.gather` for concurrent IO, NOT a thread pool unless CPU-bound.
- For deps: respect existing `pyproject.toml` / `requirements.txt`. Don't pip install ad-hoc.

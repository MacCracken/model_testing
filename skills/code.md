# Writing a function that passes hidden tests

1. Read every numbered rule; each one is a test. List the edge cases the rules name (empty input,
   ties, the fail value, boundaries) before writing anything.
2. Write the whole function, self-contained: no imports, no reading or printing, plain JavaScript.
3. If a `run_tests` tool is available, run your code with it before answering. Read every failure
   (the arguments, what was expected, what your code returned or threw), fix the code, run again,
   and only answer once the examples pass.
4. The examples are not the whole test set: the hidden tests hold the edge cases the rules name, so
   walk each rule against your code once more before you answer.
5. Return the complete function, exactly as tested — the same source, not a paraphrase.

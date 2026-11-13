# v0.7 holdout task authoring rules

This file is given verbatim to the task author and the independent reviewer.

## Your environment

- **Repository.** You work only inside the repository directory you are given: a clean detached checkout at a fixed commit. Do not modify it.
- **Tools.** Use only `git`, `rg`/`grep`, `sed`, `cat`, `ls` and `find`.
  - Never run `stellar` or any StellarCode command.
  - Never look at the StellarCode repository, its source or its validation results.
- **Output.** Write your output only to the file path you are given.

## Task set

Write exactly **12 tasks**, 3 of each category:

| Category | What the task asks |
|---|---|
| `navigation` | Where is a specific behavior owned or implemented? |
| `flow` | Trace a concrete behavior through several symbols or files, from an entry point to where the effect happens. |
| `impact` | If a specific function, method, class or contract changes, which production code must be reviewed or changed? |
| `editing-prep` | Before making a specific described change, which files must be edited? |

Each task:

```json
{
  "id": "kebab-case-unique-id",
  "category": "navigation|flow|impact|editing-prep",
  "prompt": "A natural developer question.",
  "expectedFiles": ["repo/relative/path.ext"],
  "expectedMatch": "all|any"
}
```

### Prompt rules

- Describe the behavior in **domain language**, the way a developer who knows the product but not the code would ask. Do not leak the answer:
  - no file names, file stems or directory names of expected files
  - no exact identifier of the expected symbol
- The question must be answerable from source code in the repository, and the answer must be **objective**.
- Prefer behaviors that span several symbols or files for `flow`, `impact` and `editing-prep`.
- Avoid tests, generated code, vendored code, build configuration and documentation as answers.

### `expectedFiles`

- Production source files that a correct answer must name. Use 1 file for navigation, 2–4 for the other categories.
- Use `expectedMatch: "all"` when every listed file is required, and `"any"` only when alternatives are truly equivalent.
- Every path must exist at this commit. Verify with `git ls-files`.
- Every expected file must be a source file of the **target language** you are given (its file extension). Other languages in the repository are out of scope.
- A `flow` task must span at least 2 files.

## Reviewer instructions

You review a task file written by another author for the same repository, under the same tool restrictions.

- **Each task:**
  1. Verify the prompt does not leak expected file names or symbol identifiers.
  2. Verify that the answer is objective and that `expectedFiles` is complete and correct.
  3. Verify every expected file is of the target language and is not a test file.
- **Fixing.** Fix errors in place. Delete a task you cannot make objective, then write a replacement of the same category that follows the rules.
- **Final check.** Ensure there are 12 tasks, 3 per category.
- **Notes.** Write a review note per task: `ok`, `fixed: <what>`, or `replaced: <why>`.

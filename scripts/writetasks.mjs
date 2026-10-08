/**
 * The write-a-file tasks, shared by every bench that asks the question.
 *
 * They live here rather than in one bench because the only comparison worth
 * having is the same tasks against every model - local and cloud. The first is
 * verbatim the request that failed repeatedly with phi4-mini; the rest need a
 * little more thought without needing a library.
 *
 * `wants` is not style marking. Each entry is something the task cannot be
 * solved without, so a script that compiles but skipped the actual job is
 * counted separately from one that works.
 */
export const TASKS = [
  {
    ask: "create a python file in my downloads folder that provides the specs of all the files in the current folder its in, the total memory taken, and all the file's names. don't run it",
    wants: ["os", "getsize"],
  },
  {
    ask: "write a .py file in my downloads folder that lists the 5 biggest files in it, with sizes in MB, newest first on ties",
    wants: ["sort", "1024"],
  },
  {
    ask: "make a python script in downloads that finds duplicate files by content hash and prints the groups",
    wants: ["hashlib"],
  },
  {
    ask: "write a python file in downloads that reads a csv and prints the mean of every numeric column, handling missing values",
    wants: ["csv"],
  },
];

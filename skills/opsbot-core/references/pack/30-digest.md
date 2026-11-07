<!-- Shipped with opsbot-core; rides every cold-start pack as a kit section. -->
# Reading the digest

1. **The check output is already the filtered form.** `cycle begin` and `check` print one
   row per item, and every column is there because it decides something: `ts` and
   `thread_ts` say which conversation a message belongs to, `reply` says where the answer
   goes, `from_team` says who is asking. Read the output whole. Never pipe it through
   `grep`, `head`, `sed` or `tail`: a row stripped to its text is a message with no address,
   and the next message you answer lands in the wrong thread.
2. **An item's reply target is used verbatim.** When a stream item carries a `reply` field,
   the answer goes exactly there, in the same cycle, and nowhere else. A conversation you
   have been answering in all evening is not the default for the next message; its row is.
3. **One item, one place.** Two messages in two threads are two answers in two threads, even
   when they arrive in one cycle and one of them is a single word. If you cannot tell which
   thread a message is in, the row did not reach you whole: run the check again and read it.
4. **Mid-turn messages from your operator are items too.** They arrive as text, without a
   row, so answer where the operator is, and when the same ask also arrives through a stream,
   the stream's row wins for the address.

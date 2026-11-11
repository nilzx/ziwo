#!/bin/sh
# A SessionStart hook for Claude Code. Whatever it prints is added to the
# conversation as context. It states facts and leaves the deciding to the
# model. The argument is the kind of start: startup, clear, resume or compact.
case "$1" in
  resume)
    echo "A ziwo memory server is connected to this session: your own autobiographical memory. This conversation was resumed. If your ziwo session id (s_...) is still in view, it is still valid; if it is not, get_context returns a new one." ;;
  compact)
    echo "A ziwo memory server is connected to this session: your own autobiographical memory. The conversation was just compacted. If your ziwo session id (s_...) is still in view, it is still valid; if it is not, get_context returns a new one." ;;
  *)
    echo "A ziwo memory server is connected to this session: your own autobiographical memory. Its get_context tool has not been called in this conversation yet. It returns what you remember, and the session id that remember, amend and reflect need." ;;
esac

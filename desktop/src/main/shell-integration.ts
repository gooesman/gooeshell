/** Opt-in, per-session Bash integration. No command is typed into an existing PTY. */
export const BASH_INTEGRATION_INIT = String.raw`
# An SSH exec request starts an interactive, non-login Bash. Preserve its normal rc.
if [[ -r ~/.bashrc ]]; then source ~/.bashrc; fi
__gooeshell_existing_debug=$(trap -p DEBUG)

__gooeshell_install_integration() {
  # Do not replace another tool's DEBUG trap or mutate readonly shell settings.
  if [[ -n $__gooeshell_existing_debug || $- == *T* || -n @@{VSCODE_SHELL_INTEGRATION:-} ||
        $PS1 == *']133;'* || $PS1 == *']633;'* ]] || shopt -q extdebug ||
     [[ $(declare -p PROMPT_COMMAND 2>/dev/null) =~ ^declare\ -[^[:space:]]*[rAiIn] ]] ||
     [[ $(declare -p PS1 2>/dev/null) =~ ^declare\ -[^[:space:]]*[raAiIn] ]]; then
    printf '\r\n[gooeshell] Command markers unavailable: existing shell hooks are preserved.\r\n' >&2
    return
  fi
  __gooeshell_ready=0
  __gooeshell_running=0
  __gooeshell_history=''
  __gooeshell_original_ps1=$PS1
  __gooeshell_decorated_ps1=''

  __gooeshell_preexec() {
    local __gs_status=$1 __gs_command=$2 __gs_history __gs_char __gs_escape __gs_i
    # Empty input / Ctrl+C can request another prompt without executing a command.
    if [[ $__gs_command == __gooeshell_precmd ]]; then __gooeshell_ready=0; return "$__gs_status"; fi
    if [[ $__gooeshell_ready != 1 || $BASH_SUBSHELL != 0 ]]; then return "$__gs_status"; fi
    __gooeshell_ready=0
    __gooeshell_running=1
    # History has the whole parsed command, including pipelines/multiline input.
    # Filtered/disabled history may be intentional. BASH_COMMAND can contain only
    # the first part of a pipeline, so do not offer it as a whole copyable command.
    __gs_history=$(HISTTIMEFORMAT= builtin history 1)
    if [[ $__gs_history != "$__gooeshell_history" && $__gs_history =~ ^[[:blank:]]*[0-9]+[[:blank:]]+(.*)$ ]]; then
      __gs_command=@@{BASH_REMATCH[1]}
    else
      printf '\033]133;C\007'
      return "$__gs_status"
    fi
    local LC_ALL=C
    if (( @@{#__gs_command} > 8192 )); then printf '\033]133;C\007'; return "$__gs_status"; fi
    __gs_command=@@{__gs_command//\\/\\\\}
    __gs_command=@@{__gs_command//;/\\x3b}
    # OSC text must never terminate the sequence or introduce another escape.
    for ((__gs_i=1; __gs_i<32; __gs_i++)); do
      printf -v __gs_escape '\\x%02x' "$__gs_i"
      printf -v __gs_char '%b' "$__gs_escape"
      __gs_command=@@{__gs_command//"$__gs_char"/"$__gs_escape"}
    done
    __gs_command=@@{__gs_command//$'\177'/\\x7f}
    if (( @@{#__gs_command} <= 8192 )); then printf '\033]633;E;%s\007' "$__gs_command"; fi
    printf '\033]133;C\007'
    return "$__gs_status"
  }
  __gooeshell_precmd() {
    local __gs_status=$?
    __gooeshell_ready=0
    if [[ $__gooeshell_running == 1 ]]; then
      printf '\033]133;D;%s\007' "$__gs_status"
      __gooeshell_running=0
    fi
    if [[ $PS1 == "$__gooeshell_decorated_ps1" ]]; then PS1=$__gooeshell_original_ps1; fi
    return "$__gs_status"
  }
  __gooeshell_prompt() {
    local __gs_status=$?
    __gooeshell_history=$(HISTTIMEFORMAT= builtin history 1)
    __gooeshell_original_ps1=$PS1
    PS1='\[\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]'
    __gooeshell_decorated_ps1=$PS1
    __gooeshell_ready=1
    return "$__gs_status"
  }
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    # Since Bash 5.1, each array entry is parsed separately. Preserve that order.
    PROMPT_COMMAND=(__gooeshell_precmd "@@{PROMPT_COMMAND[@]}" __gooeshell_prompt)
  else
    # Older Bash only executes the scalar/zeroth entry. Newlines also preserve a
    # trailing comment in the existing hook without swallowing our final hook.
    PROMPT_COMMAND=$'__gooeshell_precmd\n'"@@{PROMPT_COMMAND-}"$'\n__gooeshell_prompt'
  fi
  trap '__gooeshell_preexec "$?" "$BASH_COMMAND"' DEBUG
}
__gooeshell_install_integration
unset -f __gooeshell_install_integration
exec 3<&-
`.replaceAll('@@{', '${');

/** The here-document is static application code, never server/profile/user input. */
const POSIX_BOOTSTRAP = String.raw`
if [ "$(uname -s 2>/dev/null)" = Linux ] && [ "@@{SHELL##*/}" = bash ] && [ -x "$SHELL" ] && [ -d /dev/fd ]; then
  exec "$SHELL" --noprofile --rcfile /dev/fd/3 -i 3<<'GOOESHELL_BASH_INIT_42B18A'
${BASH_INTEGRATION_INIT}
GOOESHELL_BASH_INIT_42B18A
else
  printf '\r\n[gooeshell] Command markers require Linux Bash; using the normal login shell.\r\n' >&2
  exec "@@{SHELL:-/bin/sh}" -l
fi
`.replaceAll('@@{', '${');

// The account's default shell may be fish/csh. Let it parse only an exec and a
// quoted argument; a fixed POSIX shell interprets the actual bootstrap syntax.
export const SHELL_INTEGRATION_COMMAND = `exec /bin/sh -c '${POSIX_BOOTSTRAP.replaceAll("'", "'\\''")}'`;

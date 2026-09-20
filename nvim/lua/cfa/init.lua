--- Codeforces Assistant for Neovim.
---
--- This is a client. The parsing, the sample runner, the submit queue and the
--- verdict polling all live in `cfa-host`, which is the same code the VS Code
--- extension runs — so a fix lands in both, and neither editor is the one that
--- owns a contest.

local M = {}

--- Where the repository is, derived from this file rather than configured: a
--- plugin installed from a checkout knows where its own host build is.
local function repo_root()
  local source = debug.getinfo(1, 'S').source:sub(2)
  return vim.fn.fnamemodify(source, ':h:h:h:h')
end

M.config = {
  --- How to start the host. Replace with `{ 'cfa-host' }` if you have it on
  --- PATH; the default runs the build in this checkout.
  cmd = { 'node', repo_root() .. '/host/out/host/src/main.js' },
  --- Folder contests are created in, when `cfa.contestsDir` is not set in the
  --- host's settings file. Nil means the host decides.
  dir = nil,
  --- Overrides `cfa.port` from the settings file. Nil means the file decides.
  port = nil,
  --- A settings file other than $XDG_CONFIG_HOME/cfa/settings.json.
  settings = nil,
  --- Open the first captured solution when a contest arrives from the browser.
  open_on_capture = true,
}

local started = false

--- Wire up the host events. Called once, from `setup` or from the first
--- `:Cfa`, so that requiring this module does nothing on its own.
local function attach()
  if started then
    return
  end
  started = true
  local client = require('cfa.client')
  local ui = require('cfa.ui')

  client.on('run', function(message)
    ui.show_run(message.file, message.state)
  end)

  client.on('verdict', function(message)
    ui.show_verdict(message.state)
  end)

  client.on('capture', function(message)
    vim.notify(
      ('cfa: captured contest %s — %d file(s), %d sample(s)')
        :format(message.contestId, #(message.created or {}), message.samples)
    )
    local first = (message.created or {})[1]
    if M.config.open_on_capture and first then
      vim.cmd('edit ' .. vim.fn.fnameescape(first))
    end
  end)

  client.on('trust', function(message)
    -- A pairing question, relayed from the browser. Answering it is the whole
    -- reason the host refuses when no editor is attached, so it is a prompt,
    -- never an automatic yes.
    vim.ui.select({ 'Allow', 'Deny' }, {
      prompt = 'Let this browser extension use Codeforces Assistant?\n' .. message.origin,
    }, function(choice)
      client.request('trust', { origin = message.origin, allow = choice == 'Allow' })
    end)
  end)

  client.on('error', function(message)
    vim.notify('cfa: ' .. (message.error or 'unknown error'), vim.log.levels.ERROR)
  end)
end

function M.setup(opts)
  M.config = vim.tbl_extend('force', M.config, opts or {})
  attach()
end

--- Entry point for `:Cfa`, so the host is not started until something is asked
--- of it — opening Neovim should not take a port.
function M.dispatch(cmd_opts)
  attach()
  require('cfa.commands').run(cmd_opts)
end

return M

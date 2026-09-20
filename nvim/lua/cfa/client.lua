--- Newline-delimited JSON over a pipe to `cfa-host`.
---
--- The host is started on first use and stops when this Neovim exits, because
--- its stdin closes. That is deliberate: the capture server holds a port, and a
--- daemon nobody owns is a daemon nobody remembers to stop.
---
--- Every callback here runs on libuv's thread, where almost no Vim API is legal
--- to call, so each one is handed to `vim.schedule`.

local M = {}

local job = nil
local next_id = 1
local pending = {}
local listeners = {}
local tail = ''
local queue = {}
local ready = false

local function dispatch(message)
  if message.id and pending[message.id] then
    local callback = pending[message.id]
    pending[message.id] = nil
    vim.schedule(function()
      callback(message.ok and message.result or nil, message.ok and nil or (message.error or 'failed'))
    end)
    return
  end
  if message.event then
    for _, fn in ipairs(listeners[message.event] or {}) do
      vim.schedule(function()
        fn(message)
      end)
    end
  end
end

local function on_stdout(_, data)
  if not data then
    return
  end
  -- Neovim splits on newlines and marks a partial line by making the last
  -- element a fragment rather than a complete line; stitch it back together.
  data[1] = tail .. data[1]
  tail = table.remove(data) or ''
  for _, line in ipairs(data) do
    if line ~= '' then
      local ok, message = pcall(vim.json.decode, line)
      if ok and type(message) == 'table' then
        dispatch(message)
      end
    end
  end
end

local function on_stderr(_, data)
  if not data then
    return
  end
  for _, line in ipairs(data) do
    if line ~= '' then
      require('cfa.ui').record(line)
    end
  end
end

local function on_exit(_, code)
  job = nil
  ready = false
  local failed = pending
  pending = {}
  queue = {}
  vim.schedule(function()
    for _, callback in pairs(failed) do
      callback(nil, 'cfa-host exited (' .. code .. ')')
    end
    if code ~= 0 then
      vim.notify('cfa-host exited with code ' .. code .. '. :Cfa log for details.', vim.log.levels.ERROR)
    end
  end)
end

--- Register a handler for an unsolicited message from the host.
function M.on(event, fn)
  listeners[event] = listeners[event] or {}
  table.insert(listeners[event], fn)
end

function M.is_running()
  return job ~= nil
end

function M.start()
  if job then
    return true
  end
  local config = require('cfa').config
  local command = vim.deepcopy(config.cmd)
  if config.dir and config.dir ~= '' then
    vim.list_extend(command, { '--dir', vim.fn.expand(config.dir) })
  end
  if config.port then
    vim.list_extend(command, { '--port', tostring(config.port) })
  end
  if config.settings and config.settings ~= '' then
    vim.list_extend(command, { '--settings', vim.fn.expand(config.settings) })
  end

  if vim.fn.executable(command[1]) == 0 then
    vim.notify('cfa: ' .. command[1] .. ' not found on PATH', vim.log.levels.ERROR)
    return false
  end

  job = vim.fn.jobstart(command, {
    on_stdout = on_stdout,
    on_stderr = on_stderr,
    on_exit = on_exit,
  })
  if job <= 0 then
    job = nil
    vim.notify('cfa: could not start ' .. table.concat(command, ' '), vim.log.levels.ERROR)
    return false
  end
  return true
end

function M.stop()
  if job then
    vim.fn.jobstop(job)
    job = nil
    ready = false
  end
end

--- Send a request. The callback gets (result, error), exactly one of them set.
function M.request(method, params, callback)
  callback = callback or function() end
  if not M.start() then
    callback(nil, 'cfa-host is not running')
    return
  end

  local id = next_id
  next_id = next_id + 1
  pending[id] = callback
  local line = vim.json.encode({ id = id, method = method, params = params or vim.empty_dict() })

  if not ready and method ~= 'status' then
    -- The host answers before it has finished starting, but a `submit` sent
    -- during that window would be refused for a server that is about to come
    -- up. Holding it for a few milliseconds is kinder than the error.
    table.insert(queue, line)
    return
  end
  vim.fn.chansend(job, line .. '\n')
end

M.on('ready', function()
  ready = true
  for _, line in ipairs(queue) do
    if job then
      vim.fn.chansend(job, line .. '\n')
    end
  end
  queue = {}
end)

return M

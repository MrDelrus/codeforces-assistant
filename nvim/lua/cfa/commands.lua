--- The `:Cfa <command> [args]` surface.
---
--- One command with subcommands rather than `:CfaTest`, `:CfaSubmit` and the
--- rest: they share completion, they share a namespace, and the set is going to
--- grow. No key mappings are defined here — what a key does is the user's
--- choice, and `:Cfa test` is short enough to type meanwhile.

local M = {}

local client = require('cfa.client')
local ui = require('cfa.ui')

--- The file a command acts on.
---
--- With no argument it is the current buffer, which is the common case. With an
--- index — `:Cfa test B` — it is that problem in the same contest, so you can
--- run B without leaving A.
local function resolve(index, callback)
  local current = vim.api.nvim_buf_get_name(0)
  if current == '' then
    vim.notify('cfa: this buffer has no file', vim.log.levels.ERROR)
    return
  end
  if not index or index == '' then
    callback(current)
    return
  end
  client.request('problem', { file = current }, function(result, err)
    if err then
      vim.notify('cfa: ' .. err, vim.log.levels.ERROR)
      return
    end
    local wanted = index:upper()
    for _, problem in ipairs(result.problems or {}) do
      if problem.index:upper() == wanted then
        callback(problem.file)
        return
      end
    end
    vim.notify('cfa: contest ' .. result.contestId .. ' has no problem ' .. wanted, vim.log.levels.ERROR)
  end)
end

local function fail(err)
  vim.notify('cfa: ' .. err, vim.log.levels.ERROR)
end

M.commands = {}

M.commands.status = {
  help = 'server, settings and pairing state',
  run = function()
    client.request('status', {}, function(result, err)
      if err then
        return fail(err)
      end
      ui.show_status(result)
    end)
  end,
}

M.commands.test = {
  help = 'compile and run the samples [index]',
  run = function(args)
    resolve(args[1], function(file)
      -- Saving first: running the file on disk while the buffer differs is the
      -- kind of confusion that costs a contest.
      if vim.bo.modified then
        vim.cmd('write')
      end
      vim.notify('cfa: running ' .. vim.fn.fnamemodify(file, ':t'))
      client.request('test', { file = file }, function(_, err)
        if err then
          return fail(err)
        end
      end)
    end)
  end,
}

M.commands.submit = {
  help = 'queue the solution for the browser [index]',
  run = function(args)
    resolve(args[1], function(file)
      if vim.bo.modified then
        vim.cmd('write')
      end
      client.request('submit', { file = file }, function(result, err)
        if err then
          return fail(err)
        end
        vim.notify(
          ('cfa: %s queued (%d bytes) — the browser will fill the form; you press Submit')
            :format(result.problemId, result.bytes)
        )
      end)
    end)
  end,
}

M.commands.cancel = {
  help = 'stop waiting on the queued submit',
  run = function()
    client.request('cancel', {}, function(result, err)
      if err then
        return fail(err)
      end
      vim.notify(result.cancelled and 'cfa: submit cancelled' or 'cfa: nothing was queued')
    end)
  end,
}

M.commands.problem = {
  help = 'what this file is, and its siblings [index]',
  run = function(args)
    resolve(args[1], function(file)
      client.request('problem', { file = file }, function(result, err)
        if err then
          return fail(err)
        end
        local lines = {
          ('%s — %s'):format(result.id, result.name),
          result.url,
          ('limits: %s, %s'):format(result.timeLimit or '?', result.memoryLimit or '?'),
          ('samples: %d official, %d of your own'):format(result.samples, result.extraSamples),
          '',
          ('contest %d — %s'):format(result.contestId, result.contestName),
        }
        for _, problem in ipairs(result.problems or {}) do
          table.insert(lines, ('  %-3s %s'):format(problem.index, problem.name))
        end
        ui.show_lines('cfa://problem', lines)
      end)
    end)
  end,
}

M.commands.panel = {
  help = 'reopen the last run',
  run = function()
    local last = ui.last_run()
    if not last then
      return fail('nothing has been run yet')
    end
    ui.show_run(last.file, last.state)
  end,
}

M.commands.diff = {
  help = 'diff expected against actual for test <n>',
  run = function(args)
    local number = tonumber(args[1])
    if not number then
      return fail('which test? e.g. :Cfa diff 2')
    end
    ui.show_diff(number)
  end,
}

M.commands.log = {
  help = 'the host log',
  run = function()
    client.request('log', {}, function(result, err)
      if err then
        -- The host may be the thing that is broken, so fall back to whatever
        -- its stderr gave us before it went.
        ui.show_lines('cfa://log', ui.recorded())
        return
      end
      ui.show_lines('cfa://log', result.lines)
    end)
  end,
}

M.commands.forget = {
  help = 'unpair every browser extension',
  run = function()
    client.request('forget', {}, function(result, err)
      if err then
        return fail(err)
      end
      vim.notify(('cfa: forgot %d paired extension(s)'):format(result.forgotten))
    end)
  end,
}

M.commands.restart = {
  help = 'restart cfa-host',
  run = function()
    client.stop()
    vim.defer_fn(function()
      client.request('status', {}, function(_, err)
        vim.notify(err and ('cfa: ' .. err) or 'cfa: host restarted')
      end)
    end, 200)
  end,
}

M.commands.stop = {
  help = 'stop cfa-host and release the port',
  run = function()
    client.stop()
    vim.notify('cfa: host stopped')
  end,
}

function M.run(opts)
  local args = opts.fargs
  local name = args[1]
  if not name then
    return fail('which command? :Cfa status, test, submit, cancel, problem, panel, diff, log')
  end
  local command = M.commands[name]
  if not command then
    return fail('unknown command: ' .. name)
  end
  command.run({ unpack(args, 2) })
end

function M.complete(lead, line)
  local words = vim.split(vim.trim(line), '%s+')
  -- Past the subcommand, the only thing worth completing is a problem index,
  -- and that needs a round trip; leave it to the user rather than block.
  if #words > 2 or (#words == 2 and lead == '') then
    return {}
  end
  local names = vim.tbl_keys(M.commands)
  table.sort(names)
  return vim.tbl_filter(function(name)
    return name:sub(1, #lead) == lead
  end, names)
end

return M

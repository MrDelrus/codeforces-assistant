--- Everything that draws.
---
--- Results go to two places on purpose. The panel is for reading — inputs,
--- expected, actual, side by side with the test number — and the quickfix list
--- is for moving: `:cnext` walks the failures. Neither is a window that steals
--- focus while you are typing.

local M = {}

local SIGN_BY_STATUS = {
  passed = 'ok',
  failed = 'WRONG',
  error = 'ERROR',
  timeout = 'TIMEOUT',
  running = '...',
  pending = '-',
}

local last_run = nil
local log_lines = {}
local panel_buf = nil

--- Keep a host stderr line for `:Cfa log`, even before any panel exists.
function M.record(line)
  table.insert(log_lines, line)
  if #log_lines > 500 then
    table.remove(log_lines, 1)
  end
end

function M.recorded()
  return log_lines
end

function M.last_run()
  return last_run
end

local function scratch(name, lines, filetype)
  local buf = nil
  for _, candidate in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(candidate) and vim.api.nvim_buf_get_name(candidate):match(name .. '$') then
      buf = candidate
      break
    end
  end
  if not buf then
    buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(buf, name)
    vim.bo[buf].bufhidden = 'hide'
    vim.bo[buf].buftype = 'nofile'
    vim.bo[buf].swapfile = false
  end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  if filetype then
    vim.bo[buf].filetype = filetype
  end

  local window = vim.fn.bufwinid(buf)
  if window == -1 then
    vim.cmd('botright split')
    window = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(window, buf)
    vim.api.nvim_win_set_height(window, math.min(#lines + 1, 20))
    -- Back to where the user was typing; the panel is to be read, not lived in.
    vim.cmd('wincmd p')
  end
  return buf
end

local function block(label, text)
  local lines = { label .. ':' }
  for _, line in ipairs(vim.split(text or '', '\n', { plain = true })) do
    table.insert(lines, '  ' .. line)
  end
  return lines
end

--- Render a run into the panel, and its failures into the quickfix list.
function M.show_run(file, state)
  last_run = { file = file, state = state }
  local results = state.results or {}
  local lines = {}

  local header = vim.fn.fnamemodify(file, ':t') .. '  [' .. state.phase .. ']'
  table.insert(lines, header)
  table.insert(lines, string.rep('-', #header))

  if state.phase == 'failed' and state.compileOutput then
    vim.list_extend(lines, vim.split(state.compileOutput, '\n', { plain = true }))
    panel_buf = scratch('cfa://results', lines, 'cfa-results')
    vim.fn.setqflist({}, ' ', { title = 'cfa', lines = vim.split(state.compileOutput, '\n', { plain = true }) })
    return
  end

  local failures = {}
  for _, result in ipairs(results) do
    local status = SIGN_BY_STATUS[result.status] or result.status
    local tag = result.custom and ' (yours)' or ''
    table.insert(
      lines,
      string.format('#%d  %s%s  %dms', result.number, status, tag, result.durationMs or 0)
    )
    if result.status ~= 'passed' and result.status ~= 'pending' and result.status ~= 'running' then
      vim.list_extend(lines, block('  input', result.input))
      vim.list_extend(lines, block('  expected', result.expected))
      vim.list_extend(lines, block('  actual', result.actual))
      if result.stderr and result.stderr ~= '' then
        vim.list_extend(lines, block('  stderr', result.stderr))
      end
      table.insert(failures, {
        filename = file,
        lnum = 1,
        text = string.format('test %d: %s', result.number, status),
      })
    end
  end

  panel_buf = scratch('cfa://results', lines, 'cfa-results')
  vim.fn.setqflist(failures, ' ', { title = 'cfa: ' .. vim.fn.fnamemodify(file, ':t') })
end

--- Expected against actual for one test, in a real diff so long outputs are
--- readable — eyeballing two blocks of numbers is how a wrong answer is missed.
function M.show_diff(number)
  if not last_run then
    vim.notify('cfa: nothing has been run yet', vim.log.levels.WARN)
    return
  end
  local result = nil
  for _, candidate in ipairs(last_run.state.results or {}) do
    if candidate.number == number then
      result = candidate
    end
  end
  if not result then
    vim.notify('cfa: no test ' .. number .. ' in the last run', vim.log.levels.WARN)
    return
  end

  vim.cmd('tabnew')
  local expected = vim.api.nvim_get_current_buf()
  vim.api.nvim_buf_set_name(expected, 'cfa://expected/' .. number)
  vim.bo[expected].buftype = 'nofile'
  vim.api.nvim_buf_set_lines(expected, 0, -1, false, vim.split(result.expected or '', '\n', { plain = true }))
  vim.cmd('diffthis')

  vim.cmd('vsplit')
  local actual = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(actual, 'cfa://actual/' .. number)
  vim.api.nvim_win_set_buf(vim.api.nvim_get_current_win(), actual)
  vim.bo[actual].buftype = 'nofile'
  vim.api.nvim_buf_set_lines(actual, 0, -1, false, vim.split(result.actual or '', '\n', { plain = true }))
  vim.cmd('diffthis')
end

function M.show_lines(name, lines)
  scratch(name, lines, nil)
end

function M.show_status(status)
  local lines = {}
  local function add(label, value)
    table.insert(lines, string.format('%-16s %s', label, tostring(value)))
  end
  add('listening', status.listening and ('yes, port ' .. tostring(status.port)) or 'no')
  if status.portConflict then
    add('conflict', 'the port is taken by another process')
  end
  add('contests', status.contestsDir or '(not set)')
  add('language', status.language)
  add('handle', status.handle or '(unknown)')
  add('paired', #(status.trustedOrigins or {}) .. ' browser extension(s)')
  add('pending', status.pendingSubmit or 'nothing queued')
  add('settings', status.settingsFile)
  add('template', status.templateFile)
  M.show_lines('cfa://status', lines)
end

--- The verdict is a line, not a window: it changes several times per submit and
--- a window that reopens on each change is unusable.
function M.show_verdict(state)
  local level = vim.log.levels.INFO
  if state.phase == 'failed' then
    level = vim.log.levels.ERROR
  elseif state.phase == 'cancelled' or (state.phase == 'final' and state.verdict ~= 'OK') then
    level = vim.log.levels.WARN
  end
  vim.notify('cfa: ' .. (state.message or state.phase), level)
end

return M

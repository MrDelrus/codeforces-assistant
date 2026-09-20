-- Declares `:Cfa` and nothing else. No key mappings, no autocommands, and no
-- host process until the first command is run: a plugin that is installed but
-- unused should cost nothing.

if vim.g.loaded_cfa then
  return
end
vim.g.loaded_cfa = true

vim.api.nvim_create_user_command('Cfa', function(opts)
  require('cfa').dispatch(opts)
end, {
  nargs = '*',
  desc = 'Codeforces Assistant',
  complete = function(lead, line)
    return require('cfa.commands').complete(lead, line)
  end,
})

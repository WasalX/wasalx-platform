# frozen_string_literal: true

require 'yaml'

omit = Regexp.new(YAML.safe_load_file('.pre-commit-config.yaml').fetch('exclude'))
web = /\.(?:[cm]?[jt]sx?|css|ya?ml)\z/
java = /\.java\z/
dockerfile = /\A(?:Dockerfile(?:\.[^\/]+)?|.+\.dockerfile)\z/i
other = /\.(?:gypi?|py[itw]?|ipynb|tac|wsgi|rb|rake|gemspec|jbuilder|sql)\z/i
shell = /\.(?:ash|bash|bats|cbsd|csh|dash|ksh|mksh|sh|tcsh|zsh)\z/i
names = /\A(?:
  \.bash_(?:aliases|profile)|\.bashrc|\.envrc|\.pdbrc|\.profile|\.z(?:login|logout|profile|shrc|shenv)|
  Brewfile|config\.ru|direnvrc|Fastfile|Gemfile|PKGBUILD|Rakefile|Vagrantfile|wscript
)\z/x
shebang = /\A\#![^\n]*\b(?:
  ash|bash|bats|cbsd|csh|dash|ksh|mksh|sh|tcsh|zsh|python[23]?(?:\.\d+)*|ruby(?:\.\d+)*
)(?:\s|\z)/x

STDIN.each_line("\0").each_slice(2) do |status, entry|
  path = entry.delete_suffix("\0")
  next if omit.match?(path) || !File.file?(path) || File.symlink?(path)

  name = File.basename(path)
  next if status != "A\0" && !java.match?(name)

  if web.match?(name) || java.match?(name) || dockerfile.match?(name) ||
     other.match?(name) || shell.match?(name) || names.match?(name) ||
     (File.executable?(path) && shebang.match?(File.binread(path, 256)))
    print entry
  end
end

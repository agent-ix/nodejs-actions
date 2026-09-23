.PHONY: test lint

# This repo ships GitHub Actions artifacts only (see README.md) — there is no
# install/build step. `test` runs each composite action's own node:test
# suite; `lint` syntax-checks JS/mjs sources and YAML action/workflow files.

test:
	node --test publish-native-npm/test/*.test.mjs

lint:
	@status=0; \
	for f in $$(find . -path ./.git -prune -o -type f \( -name '*.mjs' -o -name '*.js' \) -print); do \
		node --check "$$f" || status=1; \
	done; \
	for f in $$(find . -path ./.git -prune -o -type f \( -name 'action.yml' -o -name '*.yml' \) -print); do \
		python3 -c "import sys, yaml; yaml.safe_load(open(sys.argv[1]))" "$$f" || status=1; \
	done; \
	exit $$status

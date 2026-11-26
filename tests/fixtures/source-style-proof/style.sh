#!/usr/bin/env bash
value='one two'
if [[ -n "$value" ]]; then
    printf '%s\n' $value
fi

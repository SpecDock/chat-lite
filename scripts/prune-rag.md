先 dry-run：
bash scripts/prune-rag.sh
确认后真删：
bash scripts/prune-rag.sh --apply
自定义比例：
bash scripts/prune-rag.sh --percent 30 --apply
小库保护阈值：
bash scripts/prune-rag.sh --min-items 500 --apply
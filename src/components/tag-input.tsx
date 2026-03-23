"use client";

import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";

interface TagInputProps {
  entityType: "ad_creative" | "landing_page" | "campaign" | "ad_set" | "ad";
  entityId: string;
}

export function TagInput({ entityType, entityId }: TagInputProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [inputValue, setInputValue] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const entityTags = useQuery(
    trpc.tag.listForEntity.queryOptions({ entityType, entityId }),
  );

  const allTags = useQuery(
    trpc.tag.search.queryOptions(
      inputValue ? { query: inputValue } : undefined,
    ),
  );

  const attachMutation = useMutation({
    ...trpc.tag.attach.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: trpc.tag.listForEntity.queryKey({ entityType, entityId }),
      });
      setInputValue("");
      setShowSuggestions(false);
    },
  });

  const detachMutation = useMutation({
    ...trpc.tag.detach.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: trpc.tag.listForEntity.queryKey({ entityType, entityId }),
      });
    },
  });

  const existingTagIds = new Set(entityTags.data?.map((t) => t.id) ?? []);
  const suggestions =
    allTags.data?.filter((t) => !existingTagIds.has(t.id)) ?? [];

  function handleAdd(tagName: string) {
    if (!tagName.trim()) return;
    attachMutation.mutate({ entityType, entityId, tagName: tagName.trim() });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd(inputValue);
    }
    if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {entityTags.data?.map((tag) => (
          <Badge
            key={tag.id}
            variant="secondary"
            className="gap-1 pr-1"
            style={tag.color ? { backgroundColor: `${tag.color}20`, borderColor: tag.color } : undefined}
          >
            {tag.name}
            <button
              type="button"
              onClick={() =>
                detachMutation.mutate({ entityType, entityId, tagId: tag.id })
              }
              className="ml-0.5 rounded-sm p-0.5 hover:bg-muted"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
      </div>

      <div className="relative">
        <Input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          onKeyDown={handleKeyDown}
          placeholder="Add tag..."
          className="h-8 text-sm"
        />
        {showSuggestions && inputValue && suggestions.length > 0 && (
          <div className="absolute top-full left-0 z-50 mt-1 w-full rounded-md border bg-popover p-1 shadow-md">
            {suggestions.slice(0, 8).map((tag) => (
              <button
                key={tag.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleAdd(tag.name);
                }}
              >
                {tag.color && (
                  <span
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                )}
                {tag.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

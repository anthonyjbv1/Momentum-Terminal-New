export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      admin_audit_log: {
        Row: {
          action: string
          actor_id: string
          alert_id: string | null
          details: Json
          id: number
          note: string | null
          performed_at: string
          target_person_id: string | null
          target_user_id: string | null
        }
        Insert: {
          action: string
          actor_id: string
          alert_id?: string | null
          details?: Json
          id?: never
          note?: string | null
          performed_at?: string
          target_person_id?: string | null
          target_user_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string
          alert_id?: string | null
          details?: Json
          id?: never
          note?: string | null
          performed_at?: string
          target_person_id?: string | null
          target_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_audit_log_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_audit_log_target_person_id_fkey"
            columns: ["target_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_audit_log_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      alerts: {
        Row: {
          created_at: string
          evidence: Json
          id: string
          person_id: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          status: string
          type: string
          updated_at: string
          user_ids: string[]
        }
        Insert: {
          created_at?: string
          evidence?: Json
          id?: string
          person_id?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity: string
          status?: string
          type: string
          updated_at?: string
          user_ids?: string[]
        }
        Update: {
          created_at?: string
          evidence?: Json
          id?: string
          person_id?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          status?: string
          type?: string
          updated_at?: string
          user_ids?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "alerts_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      behavioral_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          metadata: Json | null
          person_id: string | null
          session_id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json | null
          person_id?: string | null
          session_id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          person_id?: string | null
          session_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "behavioral_events_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "behavioral_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      data_sources: {
        Row: {
          config: Json | null
          created_at: string
          display_name: string
          id: string
          is_active: boolean
          name: string
          poll_interval_minutes: number
          tier: number
        }
        Insert: {
          config?: Json | null
          created_at?: string
          display_name: string
          id?: string
          is_active?: boolean
          name: string
          poll_interval_minutes: number
          tier: number
        }
        Update: {
          config?: Json | null
          created_at?: string
          display_name?: string
          id?: string
          is_active?: boolean
          name?: string
          poll_interval_minutes?: number
          tier?: number
        }
        Relationships: []
      }
      engine_ticks: {
        Row: {
          created_at: string
          finished_at: string
          id: string
          mood: number
          people_updated: number
          signals_processed: number
          started_at: string
          summary: Json | null
          tick_number: number
        }
        Insert: {
          created_at?: string
          finished_at: string
          id?: string
          mood?: number
          people_updated?: number
          signals_processed?: number
          started_at: string
          summary?: Json | null
          tick_number: number
        }
        Update: {
          created_at?: string
          finished_at?: string
          id?: string
          mood?: number
          people_updated?: number
          signals_processed?: number
          started_at?: string
          summary?: Json | null
          tick_number?: number
        }
        Relationships: []
      }
      excluded_parties: {
        Row: {
          added_by: string | null
          created_at: string
          id: string
          person_id: string | null
          reason: string
          removal_note: string | null
          removed_at: string | null
          removed_by: string | null
          user_id: string
        }
        Insert: {
          added_by?: string | null
          created_at?: string
          id?: string
          person_id?: string | null
          reason: string
          removal_note?: string | null
          removed_at?: string | null
          removed_by?: string | null
          user_id: string
        }
        Update: {
          added_by?: string | null
          created_at?: string
          id?: string
          person_id?: string | null
          reason?: string
          removal_note?: string | null
          removed_at?: string | null
          removed_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "excluded_parties_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excluded_parties_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excluded_parties_removed_by_fkey"
            columns: ["removed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excluded_parties_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      forecast_votes: {
        Row: {
          created_at: string
          direction: string
          id: string
          person_id: string
          reason: string
          score_at_vote: number
          superseded_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          direction: string
          id?: string
          person_id: string
          reason: string
          score_at_vote: number
          superseded_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          direction?: string
          id?: string
          person_id?: string
          reason?: string
          score_at_vote?: number
          superseded_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "forecast_votes_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      house_ledger: {
        Row: {
          amount_cents: number
          category: string
          close_id: string | null
          details: Json
          id: number
          order_id: string | null
          person_id: string
          recorded_at: string
          tick_number: number | null
          user_id: string | null
        }
        Insert: {
          amount_cents: number
          category: string
          close_id?: string | null
          details?: Json
          id?: never
          order_id?: string | null
          person_id: string
          recorded_at: string
          tick_number?: number | null
          user_id?: string | null
        }
        Update: {
          amount_cents?: number
          category?: string
          close_id?: string | null
          details?: Json
          id?: never
          order_id?: string | null
          person_id?: string
          recorded_at?: string
          tick_number?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "house_ledger_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "house_ledger_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ingest_runs: {
        Row: {
          blocked_dropped: number
          created_at: string
          duplicates_collapsed: number
          errors: number
          excluded_filtered: number
          finished_at: string | null
          forced: boolean
          id: string
          observations: number
          requested_sources: string[] | null
          signals_created: number
          snapshots_recorded: number
          sources_run: number
          started_at: string
          summary: Json | null
          trigger: string
        }
        Insert: {
          blocked_dropped?: number
          created_at?: string
          duplicates_collapsed?: number
          errors?: number
          excluded_filtered?: number
          finished_at?: string | null
          forced?: boolean
          id?: string
          observations?: number
          requested_sources?: string[] | null
          signals_created?: number
          snapshots_recorded?: number
          sources_run?: number
          started_at: string
          summary?: Json | null
          trigger: string
        }
        Update: {
          blocked_dropped?: number
          created_at?: string
          duplicates_collapsed?: number
          errors?: number
          excluded_filtered?: number
          finished_at?: string | null
          forced?: boolean
          id?: string
          observations?: number
          requested_sources?: string[] | null
          signals_created?: number
          snapshots_recorded?: number
          sources_run?: number
          started_at?: string
          summary?: Json | null
          trigger?: string
        }
        Relationships: []
      }
      inverse_pairs: {
        Row: {
          dampening: number
          id: string
          person_a_id: string
          person_b_id: string
        }
        Insert: {
          dampening?: number
          id?: string
          person_a_id: string
          person_b_id: string
        }
        Update: {
          dampening?: number
          id?: string
          person_a_id?: string
          person_b_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inverse_pairs_person_a_id_fkey"
            columns: ["person_a_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inverse_pairs_person_b_id_fkey"
            columns: ["person_b_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      live_samples: {
        Row: {
          category: string | null
          clips_in_window: number
          clips_truncated: boolean
          clips_window_from: string | null
          clips_window_to: string | null
          error: string | null
          id: number
          latency_ms: number | null
          sampled_at: string
          session_id: string
          signals_created: number
          status: string
          title: string | null
          viewer_count: number | null
        }
        Insert: {
          category?: string | null
          clips_in_window?: number
          clips_truncated?: boolean
          clips_window_from?: string | null
          clips_window_to?: string | null
          error?: string | null
          id?: never
          latency_ms?: number | null
          sampled_at: string
          session_id: string
          signals_created?: number
          status: string
          title?: string | null
          viewer_count?: number | null
        }
        Update: {
          category?: string | null
          clips_in_window?: number
          clips_truncated?: boolean
          clips_window_from?: string | null
          clips_window_to?: string | null
          error?: string | null
          id?: never
          latency_ms?: number | null
          sampled_at?: string
          session_id?: string
          signals_created?: number
          status?: string
          title?: string | null
          viewer_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "live_samples_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "live_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      live_sessions: {
        Row: {
          broadcaster_id: string
          category_latest: string | null
          category_switches: number
          channel: string
          clips_counted_to: string | null
          clips_total: number
          complete: boolean
          created_at: string
          data_source_id: string
          ended_at: string | null
          first_seen_at: string
          id: string
          largest_drop_fraction: number | null
          last_burst_at: string | null
          last_drop_at: string | null
          last_sampled_at: string | null
          last_seen_at: string
          last_surge_at: string | null
          missed_checks: number
          peak_at: string | null
          person_id: string
          sample_count: number
          signals_created: number
          started_at: string
          stream_id: string
          title_latest: string | null
          updated_at: string
          viewer_latest: number | null
          viewer_peak: number | null
          viewer_sum: number
        }
        Insert: {
          broadcaster_id: string
          category_latest?: string | null
          category_switches?: number
          channel: string
          clips_counted_to?: string | null
          clips_total?: number
          complete?: boolean
          created_at?: string
          data_source_id: string
          ended_at?: string | null
          first_seen_at: string
          id?: string
          largest_drop_fraction?: number | null
          last_burst_at?: string | null
          last_drop_at?: string | null
          last_sampled_at?: string | null
          last_seen_at: string
          last_surge_at?: string | null
          missed_checks?: number
          peak_at?: string | null
          person_id: string
          sample_count?: number
          signals_created?: number
          started_at: string
          stream_id: string
          title_latest?: string | null
          updated_at?: string
          viewer_latest?: number | null
          viewer_peak?: number | null
          viewer_sum?: number
        }
        Update: {
          broadcaster_id?: string
          category_latest?: string | null
          category_switches?: number
          channel?: string
          clips_counted_to?: string | null
          clips_total?: number
          complete?: boolean
          created_at?: string
          data_source_id?: string
          ended_at?: string | null
          first_seen_at?: string
          id?: string
          largest_drop_fraction?: number | null
          last_burst_at?: string | null
          last_drop_at?: string | null
          last_sampled_at?: string | null
          last_seen_at?: string
          last_surge_at?: string | null
          missed_checks?: number
          peak_at?: string | null
          person_id?: string
          sample_count?: number
          signals_created?: number
          started_at?: string
          stream_id?: string
          title_latest?: string | null
          updated_at?: string
          viewer_latest?: number | null
          viewer_peak?: number | null
          viewer_sum?: number
        }
        Relationships: [
          {
            foreignKeyName: "live_sessions_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "data_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_sessions_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "source_health"
            referencedColumns: ["data_source_id"]
          },
          {
            foreignKeyName: "live_sessions_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      llm_model_prices: {
        Row: {
          cache_read_per_mtok: number
          cache_write_per_mtok: number
          input_per_mtok: number
          model: string
          note: string | null
          output_per_mtok: number
          updated_at: string
        }
        Insert: {
          cache_read_per_mtok: number
          cache_write_per_mtok: number
          input_per_mtok: number
          model: string
          note?: string | null
          output_per_mtok: number
          updated_at?: string
        }
        Update: {
          cache_read_per_mtok?: number
          cache_write_per_mtok?: number
          input_per_mtok?: number
          model?: string
          note?: string | null
          output_per_mtok?: number
          updated_at?: string
        }
        Relationships: []
      }
      llm_usage: {
        Row: {
          cache_creation_input_tokens: number
          cache_read_input_tokens: number
          created_at: string
          error: string | null
          id: string
          input_tokens: number
          latency_ms: number | null
          model: string
          output_tokens: number
          person_id: string | null
          provider: string
          started_at: string | null
          status: string
          task_type: string
          tick_number: number | null
        }
        Insert: {
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
          created_at?: string
          error?: string | null
          id?: string
          input_tokens?: number
          latency_ms?: number | null
          model: string
          output_tokens?: number
          person_id?: string | null
          provider: string
          started_at?: string | null
          status?: string
          task_type: string
          tick_number?: number | null
        }
        Update: {
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
          created_at?: string
          error?: string | null
          id?: string
          input_tokens?: number
          latency_ms?: number | null
          model?: string
          output_tokens?: number
          person_id?: string | null
          provider?: string
          started_at?: string | null
          status?: string
          task_type?: string
          tick_number?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "llm_usage_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      market_tier_settings: {
        Row: {
          aggregate_exposure_cap_units: number
          alert_on_halt: boolean
          breaker_halt_seconds: number
          breaker_premium_cents: number
          breaker_price_cents: number | null
          breaker_window_seconds: number
          decay_half_life_ticks: number
          depth_units: number
          max_order_share_of_depth: number
          min_hold_seconds: number
          premium_cap_cents: number
          pricing_mode: string
          shorting_allowed: boolean
          tier: string
          updated_at: string
        }
        Insert: {
          aggregate_exposure_cap_units: number
          alert_on_halt: boolean
          breaker_halt_seconds: number
          breaker_premium_cents: number
          breaker_price_cents?: number | null
          breaker_window_seconds: number
          decay_half_life_ticks: number
          depth_units: number
          max_order_share_of_depth: number
          min_hold_seconds: number
          premium_cap_cents: number
          pricing_mode?: string
          shorting_allowed: boolean
          tier: string
          updated_at?: string
        }
        Update: {
          aggregate_exposure_cap_units?: number
          alert_on_halt?: boolean
          breaker_halt_seconds?: number
          breaker_premium_cents?: number
          breaker_price_cents?: number | null
          breaker_window_seconds?: number
          decay_half_life_ticks?: number
          depth_units?: number
          max_order_share_of_depth?: number
          min_hold_seconds?: number
          premium_cap_cents?: number
          pricing_mode?: string
          shorting_allowed?: boolean
          tier?: string
          updated_at?: string
        }
        Relationships: []
      }
      narrative_signals: {
        Row: {
          created_at: string
          narrative_id: string
          relation: string
          signal_id: string
        }
        Insert: {
          created_at?: string
          narrative_id: string
          relation?: string
          signal_id: string
        }
        Update: {
          created_at?: string
          narrative_id?: string
          relation?: string
          signal_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "narrative_signals_narrative_id_fkey"
            columns: ["narrative_id"]
            isOneToOne: false
            referencedRelation: "narratives"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "narrative_signals_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      narratives: {
        Row: {
          created_at: string
          id: string
          person_id: string
          score_after: number
          score_before: number
          source: string
          text: string
          tick_number: number
        }
        Insert: {
          created_at?: string
          id?: string
          person_id: string
          score_after: number
          score_before: number
          source?: string
          text: string
          tick_number: number
        }
        Update: {
          created_at?: string
          id?: string
          person_id?: string
          score_after?: number
          score_before?: number
          source?: string
          text?: string
          tick_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "narratives_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "narratives_tick_number_fkey"
            columns: ["tick_number"]
            isOneToOne: false
            referencedRelation: "engine_ticks"
            referencedColumns: ["tick_number"]
          },
        ]
      }
      people: {
        Row: {
          avatar_url: string | null
          base_score: number
          bio: string | null
          buy_price: number | null
          category: string
          consent_tier: number
          created_at: string
          current_score: number
          decay_half_life_ticks_override: number | null
          depth_units_override: number | null
          display_name: string
          forecast_paused: boolean
          full_name: string | null
          halt_reason: string | null
          halted_until: string | null
          id: string
          is_active: boolean
          is_discoverable: boolean
          last_tick_at: string | null
          market_inventory_units: number
          market_price: number | null
          max_allocation_cents: number
          partnership_status: string
          premium_cap_cents_override: number | null
          premium_cents: number
          pricing_mode_override: string | null
          revert_target: number
          sell_price: number | null
          shorting_override: boolean | null
          slug: string
          spread: number
          target_attention: number | null
          target_direction: number | null
          target_offset: number
          tier: string
          trading_mode: string
        }
        Insert: {
          avatar_url?: string | null
          base_score?: number
          bio?: string | null
          buy_price?: number | null
          category: string
          consent_tier?: number
          created_at?: string
          current_score?: number
          decay_half_life_ticks_override?: number | null
          depth_units_override?: number | null
          display_name: string
          forecast_paused?: boolean
          full_name?: string | null
          halt_reason?: string | null
          halted_until?: string | null
          id?: string
          is_active?: boolean
          is_discoverable?: boolean
          last_tick_at?: string | null
          market_inventory_units?: number
          market_price?: number | null
          max_allocation_cents?: number
          partnership_status?: string
          premium_cap_cents_override?: number | null
          premium_cents?: number
          pricing_mode_override?: string | null
          revert_target?: number
          sell_price?: number | null
          shorting_override?: boolean | null
          slug: string
          spread?: number
          target_attention?: number | null
          target_direction?: number | null
          target_offset?: number
          tier?: string
          trading_mode?: string
        }
        Update: {
          avatar_url?: string | null
          base_score?: number
          bio?: string | null
          buy_price?: number | null
          category?: string
          consent_tier?: number
          created_at?: string
          current_score?: number
          decay_half_life_ticks_override?: number | null
          depth_units_override?: number | null
          display_name?: string
          forecast_paused?: boolean
          full_name?: string | null
          halt_reason?: string | null
          halted_until?: string | null
          id?: string
          is_active?: boolean
          is_discoverable?: boolean
          last_tick_at?: string | null
          market_inventory_units?: number
          market_price?: number | null
          max_allocation_cents?: number
          partnership_status?: string
          premium_cap_cents_override?: number | null
          premium_cents?: number
          pricing_mode_override?: string | null
          revert_target?: number
          sell_price?: number | null
          shorting_override?: boolean | null
          slug?: string
          spread?: number
          target_attention?: number | null
          target_direction?: number | null
          target_offset?: number
          tier?: string
          trading_mode?: string
        }
        Relationships: []
      }
      person_data_sources: {
        Row: {
          config: Json | null
          created_at: string
          data_source_id: string
          external_identifier: string
          id: string
          is_active: boolean
          person_id: string
        }
        Insert: {
          config?: Json | null
          created_at?: string
          data_source_id: string
          external_identifier: string
          id?: string
          is_active?: boolean
          person_id: string
        }
        Update: {
          config?: Json | null
          created_at?: string
          data_source_id?: string
          external_identifier?: string
          id?: string
          is_active?: boolean
          person_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "person_data_sources_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "data_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_data_sources_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "source_health"
            referencedColumns: ["data_source_id"]
          },
          {
            foreignKeyName: "person_data_sources_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      person_memory: {
        Row: {
          baseline_patterns: Json
          id: string
          person_id: string
          profile: Json
          recent_context: Json
          updated_at: string
        }
        Insert: {
          baseline_patterns?: Json
          id?: string
          person_id: string
          profile?: Json
          recent_context?: Json
          updated_at?: string
        }
        Update: {
          baseline_patterns?: Json
          id?: string
          person_id?: string
          profile?: Json
          recent_context?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "person_memory_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: true
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_settings: {
        Row: {
          close_cooldown_seconds: number
          clustered_buying_min_accounts: number
          fingerprint_retention_days: number
          id: boolean
          max_daily_close_cents: number
          max_open_interest_share: number
          max_units_per_person: number
          min_order_cents: number
          new_account_age_hours: number
          new_account_burst_min_accounts: number
          price_tolerance_cents: number
          referral_spike_min_accounts: number
          require_verified_identity: boolean
          shared_infra_min_accounts: number
          shorting_enabled: boolean
          surveillance_window_seconds: number
          updated_at: string
          wash_min_round_trips: number
          wash_window_seconds: number
        }
        Insert: {
          close_cooldown_seconds?: number
          clustered_buying_min_accounts?: number
          fingerprint_retention_days?: number
          id?: boolean
          max_daily_close_cents?: number
          max_open_interest_share?: number
          max_units_per_person?: number
          min_order_cents?: number
          new_account_age_hours?: number
          new_account_burst_min_accounts?: number
          price_tolerance_cents?: number
          referral_spike_min_accounts?: number
          require_verified_identity?: boolean
          shared_infra_min_accounts?: number
          shorting_enabled?: boolean
          surveillance_window_seconds?: number
          updated_at?: string
          wash_min_round_trips?: number
          wash_window_seconds?: number
        }
        Update: {
          close_cooldown_seconds?: number
          clustered_buying_min_accounts?: number
          fingerprint_retention_days?: number
          id?: boolean
          max_daily_close_cents?: number
          max_open_interest_share?: number
          max_units_per_person?: number
          min_order_cents?: number
          new_account_age_hours?: number
          new_account_burst_min_accounts?: number
          price_tolerance_cents?: number
          referral_spike_min_accounts?: number
          require_verified_identity?: boolean
          shared_infra_min_accounts?: number
          shorting_enabled?: boolean
          surveillance_window_seconds?: number
          updated_at?: string
          wash_min_round_trips?: number
          wash_window_seconds?: number
        }
        Relationships: []
      }
      portfolio_history: {
        Row: {
          id: string
          order_id: string | null
          recorded_at: string
          tick_number: number | null
          total_value_cents: number
          user_id: string
        }
        Insert: {
          id?: string
          order_id?: string | null
          recorded_at?: string
          tick_number?: number | null
          total_value_cents: number
          user_id: string
        }
        Update: {
          id?: string
          order_id?: string | null
          recorded_at?: string
          tick_number?: number | null
          total_value_cents?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_history_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "trade_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_history_tick_number_fkey"
            columns: ["tick_number"]
            isOneToOne: false
            referencedRelation: "engine_ticks"
            referencedColumns: ["tick_number"]
          },
          {
            foreignKeyName: "portfolio_history_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      position_closes: {
        Row: {
          closed_at: string
          cost_cents: number
          direction: string
          entry_price_cents: number
          exit_base_cents: number
          exit_index_cents: number
          exit_inventory_units: number
          exit_premium_cents: number
          exit_price_cents: number
          id: string
          order_id: string
          person_id: string
          pnl_cents: number
          position_id: string
          proceeds_cents: number
          units: number
          user_id: string
        }
        Insert: {
          closed_at?: string
          cost_cents: number
          direction: string
          entry_price_cents: number
          exit_base_cents: number
          exit_index_cents: number
          exit_inventory_units?: number
          exit_premium_cents?: number
          exit_price_cents: number
          id?: string
          order_id: string
          person_id: string
          pnl_cents: number
          position_id: string
          proceeds_cents: number
          units: number
          user_id: string
        }
        Update: {
          closed_at?: string
          cost_cents?: number
          direction?: string
          entry_price_cents?: number
          exit_base_cents?: number
          exit_index_cents?: number
          exit_inventory_units?: number
          exit_premium_cents?: number
          exit_price_cents?: number
          id?: string
          order_id?: string
          person_id?: string
          pnl_cents?: number
          position_id?: string
          proceeds_cents?: number
          units?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "position_closes_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "trade_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "position_closes_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "position_closes_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "position_closes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      positions: {
        Row: {
          amount_cents: number
          closed_at: string | null
          direction: string
          entry_base_cents: number
          entry_depth_units: number | null
          entry_index_cents: number
          entry_inventory_units: number
          entry_premium_cents: number
          entry_price_cents: number
          entry_price_points: number
          id: string
          is_open: boolean
          open_cost_cents: number
          open_units: number
          opened_at: string
          order_id: string | null
          person_id: string
          units: number
          user_id: string
        }
        Insert: {
          amount_cents: number
          closed_at?: string | null
          direction: string
          entry_base_cents: number
          entry_depth_units?: number | null
          entry_index_cents: number
          entry_inventory_units?: number
          entry_premium_cents?: number
          entry_price_cents: number
          entry_price_points: number
          id?: string
          is_open?: boolean
          open_cost_cents: number
          open_units: number
          opened_at?: string
          order_id?: string | null
          person_id: string
          units: number
          user_id: string
        }
        Update: {
          amount_cents?: number
          closed_at?: string | null
          direction?: string
          entry_base_cents?: number
          entry_depth_units?: number | null
          entry_index_cents?: number
          entry_inventory_units?: number
          entry_premium_cents?: number
          entry_price_cents?: number
          entry_price_points?: number
          id?: string
          is_open?: boolean
          open_cost_cents?: number
          open_units?: number
          opened_at?: string
          order_id?: string | null
          person_id?: string
          units?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "trade_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      premium_history: {
        Row: {
          cause: string
          depth_units: number | null
          id: number
          inventory_after_units: number
          inventory_before_units: number
          order_id: string | null
          person_id: string
          premium_after_cents: number
          premium_before_cents: number
          recorded_at: string
          score: number
          tick_number: number | null
        }
        Insert: {
          cause: string
          depth_units?: number | null
          id?: never
          inventory_after_units: number
          inventory_before_units: number
          order_id?: string | null
          person_id: string
          premium_after_cents: number
          premium_before_cents: number
          recorded_at: string
          score: number
          tick_number?: number | null
        }
        Update: {
          cause?: string
          depth_units?: number | null
          id?: never
          inventory_after_units?: number
          inventory_before_units?: number
          order_id?: string | null
          person_id?: string
          premium_after_cents?: number
          premium_before_cents?: number
          recorded_at?: string
          score?: number
          tick_number?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "premium_history_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      publisher_domains: {
        Row: {
          created_at: string
          domain: string
          note: string | null
          status: string
          tier: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          domain: string
          note?: string | null
          status: string
          tier?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          domain?: string
          note?: string | null
          status?: string
          tier?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      publisher_feeds: {
        Row: {
          consecutive_failures: number
          created_at: string
          discovered_url: string | null
          domain: string
          etag: string | null
          id: string
          is_active: boolean
          last_dated_count: number | null
          last_described_count: number | null
          last_error: string | null
          last_fetched_at: string | null
          last_http_status: number | null
          last_item_count: number | null
          last_matched_count: number | null
          last_modified: string | null
          last_newest_published_at: string | null
          last_status: string | null
          mode: string
          note: string | null
          section: string
          topics: string[]
          updated_at: string
          url: string
        }
        Insert: {
          consecutive_failures?: number
          created_at?: string
          discovered_url?: string | null
          domain: string
          etag?: string | null
          id?: string
          is_active?: boolean
          last_dated_count?: number | null
          last_described_count?: number | null
          last_error?: string | null
          last_fetched_at?: string | null
          last_http_status?: number | null
          last_item_count?: number | null
          last_matched_count?: number | null
          last_modified?: string | null
          last_newest_published_at?: string | null
          last_status?: string | null
          mode?: string
          note?: string | null
          section: string
          topics?: string[]
          updated_at?: string
          url: string
        }
        Update: {
          consecutive_failures?: number
          created_at?: string
          discovered_url?: string | null
          domain?: string
          etag?: string | null
          id?: string
          is_active?: boolean
          last_dated_count?: number | null
          last_described_count?: number | null
          last_error?: string | null
          last_fetched_at?: string | null
          last_http_status?: number | null
          last_item_count?: number | null
          last_matched_count?: number | null
          last_modified?: string | null
          last_newest_published_at?: string | null
          last_status?: string | null
          mode?: string
          note?: string | null
          section?: string
          topics?: string[]
          updated_at?: string
          url?: string
        }
        Relationships: []
      }
      rate_limit_buckets: {
        Row: {
          hits: number
          key: string
          window_started_at: string
        }
        Insert: {
          hits?: number
          key: string
          window_started_at: string
        }
        Update: {
          hits?: number
          key?: string
          window_started_at?: string
        }
        Relationships: []
      }
      raw_metric_observations: {
        Row: {
          created_at: string
          data_source_id: string
          delta: number | null
          delta_kind: string | null
          id: string
          mean: number | null
          metric_key: string
          min_samples: number | null
          observed: number | null
          outcome: string
          person_id: string
          previous: number | null
          recorded_at: string
          register: string | null
          run_id: string
          samples: number | null
          sd: number | null
          sd_applied: number | null
          sigma: number | null
          signal_id: string | null
          value: number
          window_hours: number | null
        }
        Insert: {
          created_at?: string
          data_source_id: string
          delta?: number | null
          delta_kind?: string | null
          id?: string
          mean?: number | null
          metric_key: string
          min_samples?: number | null
          observed?: number | null
          outcome: string
          person_id: string
          previous?: number | null
          recorded_at: string
          register?: string | null
          run_id: string
          samples?: number | null
          sd?: number | null
          sd_applied?: number | null
          sigma?: number | null
          signal_id?: string | null
          value: number
          window_hours?: number | null
        }
        Update: {
          created_at?: string
          data_source_id?: string
          delta?: number | null
          delta_kind?: string | null
          id?: string
          mean?: number | null
          metric_key?: string
          min_samples?: number | null
          observed?: number | null
          outcome?: string
          person_id?: string
          previous?: number | null
          recorded_at?: string
          register?: string | null
          run_id?: string
          samples?: number | null
          sd?: number | null
          sd_applied?: number | null
          sigma?: number | null
          signal_id?: string | null
          value?: number
          window_hours?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "raw_metric_observations_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "data_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_metric_observations_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "source_health"
            referencedColumns: ["data_source_id"]
          },
          {
            foreignKeyName: "raw_metric_observations_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_metric_observations_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_metric_observations_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_source_snapshots: {
        Row: {
          data_source_id: string
          id: string
          metric_key: string
          person_id: string
          recorded_at: string
          value: number
        }
        Insert: {
          data_source_id: string
          id?: string
          metric_key: string
          person_id: string
          recorded_at?: string
          value: number
        }
        Update: {
          data_source_id?: string
          id?: string
          metric_key?: string
          person_id?: string
          recorded_at?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "raw_source_snapshots_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "data_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_source_snapshots_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "source_health"
            referencedColumns: ["data_source_id"]
          },
          {
            foreignKeyName: "raw_source_snapshots_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      score_events: {
        Row: {
          created_at: string
          details: Json | null
          force: string
          id: string
          impact: number
          person_id: string
          tick_number: number
        }
        Insert: {
          created_at?: string
          details?: Json | null
          force: string
          id?: string
          impact: number
          person_id: string
          tick_number: number
        }
        Update: {
          created_at?: string
          details?: Json | null
          force?: string
          id?: string
          impact?: number
          person_id?: string
          tick_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "score_events_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_events_tick_number_fkey"
            columns: ["tick_number"]
            isOneToOne: false
            referencedRelation: "engine_ticks"
            referencedColumns: ["tick_number"]
          },
        ]
      }
      score_history: {
        Row: {
          id: string
          person_id: string
          recorded_at: string
          score: number
          tick_number: number
        }
        Insert: {
          id?: string
          person_id: string
          recorded_at?: string
          score: number
          tick_number: number
        }
        Update: {
          id?: string
          person_id?: string
          recorded_at?: string
          score?: number
          tick_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "score_history_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      signals: {
        Row: {
          created_at: string
          data_source_id: string
          dedupe_key: string | null
          headline: string
          id: string
          impact_score: number | null
          occurred_at: string
          person_id: string
          processed: boolean
          processed_at: string | null
          raw_payload: Json | null
          sentiment_confidence: number | null
          sentiment_label: string | null
          tier: number | null
        }
        Insert: {
          created_at?: string
          data_source_id: string
          dedupe_key?: string | null
          headline: string
          id?: string
          impact_score?: number | null
          occurred_at?: string
          person_id: string
          processed?: boolean
          processed_at?: string | null
          raw_payload?: Json | null
          sentiment_confidence?: number | null
          sentiment_label?: string | null
          tier?: number | null
        }
        Update: {
          created_at?: string
          data_source_id?: string
          dedupe_key?: string | null
          headline?: string
          id?: string
          impact_score?: number | null
          occurred_at?: string
          person_id?: string
          processed?: boolean
          processed_at?: string | null
          raw_payload?: Json | null
          sentiment_confidence?: number | null
          sentiment_label?: string | null
          tier?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "signals_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "data_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signals_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "source_health"
            referencedColumns: ["data_source_id"]
          },
          {
            foreignKeyName: "signals_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      source_polls: {
        Row: {
          blocked_dropped: number
          created_at: string
          data_source_id: string
          detail: Json | null
          duplicates_collapsed: number
          excluded_filtered: number
          finished_at: string
          id: string
          latency_ms: number | null
          observations: number
          person_id: string | null
          reason: string | null
          run_id: string
          signals_created: number
          snapshots_recorded: number
          started_at: string
          status: string
        }
        Insert: {
          blocked_dropped?: number
          created_at?: string
          data_source_id: string
          detail?: Json | null
          duplicates_collapsed?: number
          excluded_filtered?: number
          finished_at: string
          id?: string
          latency_ms?: number | null
          observations?: number
          person_id?: string | null
          reason?: string | null
          run_id: string
          signals_created?: number
          snapshots_recorded?: number
          started_at: string
          status: string
        }
        Update: {
          blocked_dropped?: number
          created_at?: string
          data_source_id?: string
          detail?: Json | null
          duplicates_collapsed?: number
          excluded_filtered?: number
          finished_at?: string
          id?: string
          latency_ms?: number | null
          observations?: number
          person_id?: string | null
          reason?: string | null
          run_id?: string
          signals_created?: number
          snapshots_recorded?: number
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "source_polls_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "data_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_polls_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "source_health"
            referencedColumns: ["data_source_id"]
          },
          {
            foreignKeyName: "source_polls_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_polls_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "ingest_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      surveillance_events: {
        Row: {
          alert_id: string | null
          detector: string
          evidence: Json
          id: number
          person_id: string | null
          recorded_at: string
          severity: string
          user_ids: string[]
        }
        Insert: {
          alert_id?: string | null
          detector: string
          evidence?: Json
          id?: never
          person_id?: string | null
          recorded_at?: string
          severity: string
          user_ids?: string[]
        }
        Update: {
          alert_id?: string | null
          detector?: string
          evidence?: Json
          id?: never
          person_id?: string | null
          recorded_at?: string
          severity?: string
          user_ids?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "surveillance_events_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "surveillance_events_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_events: {
        Row: {
          amount_cents: number
          created_at: string
          id: string
          person_id: string
          side: string
          user_id: string | null
        }
        Insert: {
          amount_cents: number
          created_at?: string
          id?: string
          person_id: string
          side: string
          user_id?: string | null
        }
        Update: {
          amount_cents?: number
          created_at?: string
          id?: string
          person_id?: string
          side?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trade_events_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_orders: {
        Row: {
          balance_after_cents: number | null
          base_price_cents: number
          closed_units: number
          cost_cents: number
          created_at: string
          depth_units: number | null
          fill_price_cents: number
          fingerprint_hash: string | null
          gross_cents: number
          id: string
          impact_cents: number
          inventory_after_units: number
          inventory_before_units: number
          opened_units: number
          person_id: string
          premium_after_cents: number
          premium_before_cents: number
          proceeds_cents: number
          quantity_scale: string
          quoted_price_cents: number | null
          realized_pnl_cents: number
          requested_spend_cents: number | null
          side: string
          surface: string | null
          units: number
          user_id: string
          worst_fill_cents: number
        }
        Insert: {
          balance_after_cents?: number | null
          base_price_cents: number
          closed_units?: number
          cost_cents?: number
          created_at?: string
          depth_units?: number | null
          fill_price_cents: number
          fingerprint_hash?: string | null
          gross_cents: number
          id?: string
          impact_cents?: number
          inventory_after_units?: number
          inventory_before_units?: number
          opened_units?: number
          person_id: string
          premium_after_cents?: number
          premium_before_cents?: number
          proceeds_cents?: number
          quantity_scale?: string
          quoted_price_cents?: number | null
          realized_pnl_cents?: number
          requested_spend_cents?: number | null
          side: string
          surface?: string | null
          units: number
          user_id: string
          worst_fill_cents: number
        }
        Update: {
          balance_after_cents?: number | null
          base_price_cents?: number
          closed_units?: number
          cost_cents?: number
          created_at?: string
          depth_units?: number | null
          fill_price_cents?: number
          fingerprint_hash?: string | null
          gross_cents?: number
          id?: string
          impact_cents?: number
          inventory_after_units?: number
          inventory_before_units?: number
          opened_units?: number
          person_id?: string
          premium_after_cents?: number
          premium_before_cents?: number
          proceeds_cents?: number
          quantity_scale?: string
          quoted_price_cents?: number | null
          realized_pnl_cents?: number
          requested_spend_cents?: number | null
          side?: string
          surface?: string | null
          units?: number
          user_id?: string
          worst_fill_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "trade_orders_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_orders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      transactions: {
        Row: {
          amount_cents: number
          created_at: string
          id: string
          order_id: string | null
          person_id: string | null
          type: string
          user_id: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          id?: string
          order_id?: string | null
          person_id?: string | null
          type: string
          user_id: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          id?: string
          order_id?: string | null
          person_id?: string | null
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transactions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "trade_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          buying_power_cents: number
          created_at: string
          display_name: string
          email: string
          frozen_at: string | null
          frozen_reason: string | null
          id: string
          identity_verified_at: string | null
          is_admin: boolean
          referred_by: string | null
          username: string
          verified_identity_key: string | null
          wallet_balance_cents: number
        }
        Insert: {
          avatar_url?: string | null
          buying_power_cents?: number
          created_at?: string
          display_name: string
          email: string
          frozen_at?: string | null
          frozen_reason?: string | null
          id: string
          identity_verified_at?: string | null
          is_admin?: boolean
          referred_by?: string | null
          username: string
          verified_identity_key?: string | null
          wallet_balance_cents?: number
        }
        Update: {
          avatar_url?: string | null
          buying_power_cents?: number
          created_at?: string
          display_name?: string
          email?: string
          frozen_at?: string | null
          frozen_reason?: string | null
          id?: string
          identity_verified_at?: string | null
          is_admin?: boolean
          referred_by?: string | null
          username?: string
          verified_identity_key?: string | null
          wallet_balance_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "users_referred_by_fkey"
            columns: ["referred_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      waitlist: {
        Row: {
          consent_at: string
          created_at: string
          email: string
          id: string
          referrer: string | null
          source: string | null
          utm_campaign: string | null
          utm_content: string | null
          utm_medium: string | null
          utm_source: string | null
          utm_term: string | null
        }
        Insert: {
          consent_at?: string
          created_at?: string
          email: string
          id?: string
          referrer?: string | null
          source?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
        }
        Update: {
          consent_at?: string
          created_at?: string
          email?: string
          id?: string
          referrer?: string | null
          source?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      llm_cost_per_tick: {
        Row: {
          anomaly_calls: number | null
          avg_latency_ms: number | null
          cache_creation_input_tokens: number | null
          cache_read_input_tokens: number | null
          calls: number | null
          completed_calls: number | null
          cost_usd: number | null
          failed_calls: number | null
          first_call_at: string | null
          input_tokens: number | null
          last_call_at: string | null
          memory_calls: number | null
          narrative_calls: number | null
          output_tokens: number | null
          sentiment_calls: number | null
          started_calls: number | null
          tick_number: number | null
          unpriced_calls: number | null
        }
        Relationships: []
      }
      metric_baseline_progress: {
        Row: {
          first_snapshot_at: string | null
          last_emitted_signal: boolean | null
          last_observed_at: string | null
          last_outcome: string | null
          last_snapshot_at: string | null
          metric_key: string | null
          min_samples: number | null
          person_name: string | null
          person_slug: string | null
          sample_progress: number | null
          samples: number | null
          snapshots: number | null
          source: string | null
          span_hours: number | null
          span_progress: number | null
          window_hours: number | null
        }
        Relationships: []
      }
      observe_only_snapshots: {
        Row: {
          identifier: string | null
          metric_key: string | null
          person_slug: string | null
          recorded_at: string | null
          source: string | null
          value: number | null
        }
        Relationships: []
      }
      source_health: {
        Row: {
          avg_latency_ms_24h: number | null
          blocked_24h: number | null
          collapsed_24h: number | null
          data_source_id: string | null
          display_name: string | null
          error_rate_24h: number | null
          errors_24h: number | null
          excluded_24h: number | null
          is_active: boolean | null
          last_error: string | null
          last_error_at: string | null
          last_poll_at: string | null
          last_skip_reason: string | null
          last_success_at: string | null
          name: string | null
          people_mapped: number | null
          poll_interval_minutes: number | null
          polls_24h: number | null
          signals_24h: number | null
          tier: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      admin_add_excluded_party: {
        Args: {
          p_alert_id?: string
          p_person_id: string
          p_reason: string
          p_user_id: string
        }
        Returns: Json
      }
      admin_freeze_account: {
        Args: { p_alert_id?: string; p_reason: string; p_user_id: string }
        Returns: Json
      }
      admin_halt_person: {
        Args: {
          p_alert_id?: string
          p_person_id: string
          p_reason: string
          p_seconds: number
        }
        Returns: Json
      }
      admin_lift_halt: {
        Args: { p_alert_id?: string; p_note: string; p_person_id: string }
        Returns: Json
      }
      admin_remove_excluded_party: {
        Args: {
          p_alert_id?: string
          p_excluded_party_id: string
          p_note: string
        }
        Returns: Json
      }
      admin_resolve_alert: {
        Args: { p_alert_id: string; p_note: string; p_status: string }
        Returns: Json
      }
      admin_set_trading_mode: {
        Args: {
          p_alert_id?: string
          p_mode: string
          p_person_id: string
          p_reason: string
        }
        Returns: Json
      }
      admin_unfreeze_account: {
        Args: { p_alert_id?: string; p_note: string; p_user_id: string }
        Returns: Json
      }
      apply_engine_tick: { Args: { p_tick: Json }; Returns: Json }
      apply_market_decay: {
        Args: { p_at: string; p_tick_number: number }
        Returns: number
      }
      assert_admin: { Args: never; Returns: string }
      assert_position_direction: {
        Args: {
          p_amount_cents: number
          p_person_id: string
          p_side: string
          p_user_id: string
        }
        Returns: {
          net_after: number
          net_before: number
          open_cents: number
          open_direction: string
          reduce_cents: number
          shorting_enabled: boolean
        }[]
      }
      behavioral_co_engagement: {
        Args: {
          p_event_types?: string[]
          p_limit?: number
          p_min_shared_users?: number
          p_since: string
        }
        Returns: {
          person_a: string
          person_b: string
          shared_users: number
          users_a: number
          users_b: number
        }[]
      }
      behavioral_person_engagement: {
        Args: { p_person_id: string; p_since: string }
        Returns: {
          detail: string
          event_count: number
          event_type: string
          grouping_level: number
          total_duration_ms: number
          unique_users: number
        }[]
      }
      behavioral_user_history: {
        Args: { p_event_types?: string[]; p_since: string; p_user_id: string }
        Returns: {
          event_count: number
          event_type: string
          first_at: string
          last_at: string
          person_id: string
          total_duration_ms: number
        }[]
      }
      cast_forecast_vote: {
        Args: { p_direction: string; p_person_id: string; p_reason: string }
        Returns: Json
      }
      cents_to_dollars_text: { Args: { p_cents: number }; Returns: string }
      credit_paper_balance: {
        Args: { p_amount_cents: number; p_user_id: string }
        Returns: Json
      }
      evaluate_price_breakers: {
        Args: { p_at: string; p_tick_number: number }
        Returns: number
      }
      feed_entries: {
        Args: { p_before?: string; p_before_id?: string; p_limit?: number }
        Returns: {
          evidence: Json
          id: string
          impact: number
          kind: string
          occurred_at: string
          person_avatar: string
          person_category: string
          person_id: string
          person_name: string
          person_slug: string
          score_after: number
          score_before: number
          sources: string[]
          text: string
          tick_number: number
        }[]
      }
      forecast_min_votes: { Args: never; Returns: number }
      forecast_rate_limit_per_hour: { Args: never; Returns: number }
      forecast_summary: { Args: { p_person_id: string }; Returns: Json }
      forecast_vote_json: {
        Args: { v: Database["public"]["Tables"]["forecast_votes"]["Row"] }
        Returns: Json
      }
      halt_person: {
        Args: {
          p_at: string
          p_evidence?: Json
          p_force_alert?: boolean
          p_person_id: string
          p_reason: string
          p_seconds: number
          p_source: string
        }
        Returns: string
      }
      home_momentum: {
        Args: { p_points?: number; p_sample?: number; p_window?: string }
        Returns: {
          change: number
          person_id: string
          points: number
          sparkline: number[]
        }[]
      }
      index_cents_at: {
        Args: { p_at: string; p_person_id: string }
        Returns: number
      }
      join_waitlist: {
        Args: {
          p_email: string
          p_referrer?: string
          p_source?: string
          p_utm?: Json
        }
        Returns: Json
      }
      market_average_cents: {
        Args: {
          p_base_cents: number
          p_depth_units: number
          p_direction: string
          p_inventory_units: number
          p_units: number
        }
        Returns: number
      }
      market_cap_inventory_units: {
        Args: { p_cap_cents: number; p_depth_units: number }
        Returns: number
      }
      market_decay_divisor: {
        Args: { p_half_life_ticks: number }
        Returns: number
      }
      market_decay_step: {
        Args: { p_divisor: number; p_inventory_units: number }
        Returns: number
      }
      market_impact_cents: {
        Args: { p_depth_units: number; p_units: number }
        Returns: number
      }
      market_lot_amount_cents: {
        Args: {
          p_base_cents: number
          p_depth_units: number
          p_direction: string
          p_inventory_units: number
          p_units: number
        }
        Returns: number
      }
      market_marginal_cents: {
        Args: {
          p_base_cents: number
          p_depth_units: number
          p_inventory_units: number
          p_rounding: string
        }
        Returns: number
      }
      market_order_gross_cents: {
        Args: {
          p_base_cents: number
          p_closed_units: number
          p_depth_units: number
          p_inventory_before_units: number
          p_opened_units: number
          p_side: string
          p_units: number
        }
        Returns: number
      }
      market_params_for: {
        Args: { p_person_id: string }
        Returns: {
          aggregate_exposure_cap_units: number
          alert_on_halt: boolean
          breaker_halt_seconds: number
          breaker_premium_cents: number
          breaker_price_cents: number | null
          breaker_window_seconds: number
          decay_half_life_ticks: number
          depth_units: number
          max_order_share_of_depth: number
          min_hold_seconds: number
          premium_cap_cents: number
          pricing_mode: string
          shorting_allowed: boolean
          tier: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "market_tier_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      market_premium_cents: {
        Args: { p_depth_units: number; p_inventory_units: number }
        Returns: number
      }
      market_walk_cents: {
        Args: {
          p_base_cents: number
          p_depth_units: number
          p_direction: string
          p_inventory_units: number
          p_rounding: string
          p_units: number
        }
        Returns: number
      }
      my_portfolio: { Args: never; Returns: Json }
      my_portfolio_value_series: {
        Args: { p_points?: number; p_since?: string }
        Returns: {
          bucket_at: string
          open_cents: number
          samples: number
          value_cents: number
        }[]
      }
      my_position: { Args: { p_person_id: string }; Returns: Json }
      my_trade_history: {
        Args: { p_before?: string; p_before_id?: string; p_limit?: number }
        Returns: {
          balance_after_cents: number
          closed_units: number
          cost_cents: number
          created_at: string
          fill_price_cents: number
          gross_cents: number
          id: string
          opened_units: number
          person_avatar: string
          person_category: string
          person_id: string
          person_name: string
          person_slug: string
          proceeds_cents: number
          realized_pnl_cents: number
          side: string
          surface: string
          units: number
          units_per_share: number
        }[]
      }
      net_position_cents: {
        Args: { p_person_id: string; p_user_id: string }
        Returns: number
      }
      net_position_units: {
        Args: { p_person_id: string; p_user_id: string }
        Returns: number
      }
      person_market_series: {
        Args: { p_person_id: string; p_points?: number; p_since?: string }
        Returns: {
          bucket_at: string
          market: number
          market_open: number
          open: number
          samples: number
          score: number
        }[]
      }
      person_score_series: {
        Args: { p_person_id: string; p_points?: number; p_since?: string }
        Returns: {
          bucket_at: string
          open: number
          samples: number
          score: number
        }[]
      }
      person_signal_volume: {
        Args: { p_days?: number }
        Returns: {
          current_24h: number
          daily: number[]
          person_id: string
          tracked_since: string
        }[]
      }
      place_order: {
        Args: {
          p_fingerprint_hash?: string
          p_max_spend_cents?: number
          p_person_id: string
          p_quantity_scale?: string
          p_quoted_price_cents?: number
          p_side: string
          p_surface?: string
          p_units?: number
        }
        Returns: Json
      }
      placeholder_financial_mutation: {
        Args: { p_amount_cents: number }
        Returns: undefined
      }
      points_to_cents: { Args: { p_points: number }; Returns: number }
      portfolio_summary_for: { Args: { p_user_id: string }; Returns: Json }
      portfolio_value_cents: { Args: { p_user_id: string }; Returns: number }
      portfolio_value_series_for: {
        Args: { p_points?: number; p_since?: string; p_user_id: string }
        Returns: {
          bucket_at: string
          open_cents: number
          samples: number
          value_cents: number
        }[]
      }
      position_summary_for: {
        Args: { p_person_id: string; p_user_id: string }
        Returns: Json
      }
      premium_cents_at: {
        Args: { p_at: string; p_person_id: string }
        Returns: number
      }
      rate_limit_hit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number }
        Returns: Json
      }
      record_feed_health: { Args: { rows: Json }; Returns: number }
      record_narratives: { Args: { p_narratives: Json }; Returns: number }
      record_portfolio_snapshot: {
        Args: {
          p_at?: string
          p_order_id?: string
          p_tick_number?: number
          p_user_id: string
        }
        Returns: number
      }
      record_premium_change: {
        Args: {
          p_after: number
          p_at: string
          p_before: number
          p_cause: string
          p_depth: number
          p_order_id?: string
          p_person_id: string
          p_score: number
          p_tick?: number
        }
        Returns: number
      }
      reset_paper_balance: { Args: { p_user_id: string }; Returns: Json }
      resolve_position_order: {
        Args: {
          p_amount_cents: number
          p_net_before: number
          p_shorting_enabled: boolean
          p_side: string
        }
        Returns: {
          net_after: number
          open_cents: number
          open_direction: string
          reduce_cents: number
        }[]
      }
      run_surveillance: {
        Args: {
          p_at: string
          p_fingerprint_hash: string
          p_order_id: string
          p_person_id: string
          p_user_id: string
        }
        Returns: number
      }
      search_key: { Args: { p_text: string }; Returns: string }
      search_people: {
        Args: { p_limit?: number; p_query: string }
        Returns: {
          avatar_url: string
          category: string
          change: number
          current_score: number
          display_name: string
          id: string
          match_rank: number
          slug: string
        }[]
      }
      search_terms: { Args: { p_text: string }; Returns: string }
      shares_label: { Args: { p_units: number }; Returns: string }
      shares_text: { Args: { p_units: number }; Returns: string }
      shorting_enabled: { Args: never; Returns: boolean }
      snapshot_portfolios: {
        Args: { p_at: string; p_tick_number?: number }
        Returns: number
      }
      starting_balance_cents: { Args: never; Returns: number }
      surveillance_emit: {
        Args: {
          p_at: string
          p_evidence: Json
          p_observed: number
          p_order_id: string
          p_person_id: string
          p_severity: string
          p_since: string
          p_threshold: number
          p_type: string
          p_users: string[]
        }
        Returns: number
      }
      trade_history_for: {
        Args: {
          p_before?: string
          p_before_id?: string
          p_limit?: number
          p_user_id: string
        }
        Returns: {
          balance_after_cents: number
          closed_units: number
          cost_cents: number
          created_at: string
          fill_price_cents: number
          gross_cents: number
          id: string
          opened_units: number
          person_avatar: string
          person_category: string
          person_id: string
          person_name: string
          person_slug: string
          proceeds_cents: number
          realized_pnl_cents: number
          side: string
          surface: string
          units: number
          units_per_share: number
        }[]
      }
      trade_quote: { Args: { p_person_id: string }; Returns: Json }
      trade_rejection: {
        Args: {
          p_code: string
          p_extra?: Json
          p_message: string
          p_quote: Json
        }
        Returns: Json
      }
      units_cost_cents: {
        Args: { p_price_cents: number; p_units: number }
        Returns: number
      }
      units_per_share: { Args: never; Returns: number }
      units_proceeds_cents: {
        Args: { p_price_cents: number; p_units: number }
        Returns: number
      }
      username_available: { Args: { p_username: string }; Returns: boolean }
      wait_text: { Args: { p_seconds: number }; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

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
      behavioral_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          metadata: Json | null
          person_id: string | null
          session_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json | null
          person_id?: string | null
          session_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          person_id?: string | null
          session_id?: string | null
          user_id?: string
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
      ingest_runs: {
        Row: {
          created_at: string
          errors: number
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
          created_at?: string
          errors?: number
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
          created_at?: string
          errors?: number
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
          id: string
          input_tokens: number
          latency_ms: number | null
          model: string
          output_tokens: number
          person_id: string | null
          provider: string
          task_type: string
          tick_number: number | null
        }
        Insert: {
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
          created_at?: string
          id?: string
          input_tokens?: number
          latency_ms?: number | null
          model: string
          output_tokens?: number
          person_id?: string | null
          provider: string
          task_type: string
          tick_number?: number | null
        }
        Update: {
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
          created_at?: string
          id?: string
          input_tokens?: number
          latency_ms?: number | null
          model?: string
          output_tokens?: number
          person_id?: string | null
          provider?: string
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
          display_name: string
          full_name: string | null
          id: string
          is_active: boolean
          last_tick_at: string | null
          max_allocation_cents: number
          partnership_status: string
          revert_target: number
          sell_price: number | null
          slug: string
          spread: number
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
          display_name: string
          full_name?: string | null
          id?: string
          is_active?: boolean
          last_tick_at?: string | null
          max_allocation_cents?: number
          partnership_status?: string
          revert_target?: number
          sell_price?: number | null
          slug: string
          spread?: number
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
          display_name?: string
          full_name?: string | null
          id?: string
          is_active?: boolean
          last_tick_at?: string | null
          max_allocation_cents?: number
          partnership_status?: string
          revert_target?: number
          sell_price?: number | null
          slug?: string
          spread?: number
        }
        Relationships: []
      }
      person_data_sources: {
        Row: {
          data_source_id: string
          external_identifier: string
          id: string
          is_active: boolean
          person_id: string
        }
        Insert: {
          data_source_id: string
          external_identifier: string
          id?: string
          is_active?: boolean
          person_id: string
        }
        Update: {
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
          id: boolean
          max_daily_close_cents: number
          max_open_interest_share: number
          max_units_per_person: number
          price_tolerance_cents: number
          shorting_enabled: boolean
          updated_at: string
        }
        Insert: {
          close_cooldown_seconds?: number
          id?: boolean
          max_daily_close_cents?: number
          max_open_interest_share?: number
          max_units_per_person?: number
          price_tolerance_cents?: number
          shorting_enabled?: boolean
          updated_at?: string
        }
        Update: {
          close_cooldown_seconds?: number
          id?: boolean
          max_daily_close_cents?: number
          max_open_interest_share?: number
          max_units_per_person?: number
          price_tolerance_cents?: number
          shorting_enabled?: boolean
          updated_at?: string
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
          entry_price_cents: number
          entry_score: number
          id: string
          is_open: boolean
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
          entry_price_cents: number
          entry_score: number
          id?: string
          is_open?: boolean
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
          entry_price_cents?: number
          entry_score?: number
          id?: string
          is_open?: boolean
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
          created_at: string
          data_source_id: string
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
          created_at?: string
          data_source_id: string
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
          created_at?: string
          data_source_id?: string
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
          closed_units: number
          created_at: string
          fill_price_cents: number
          gross_cents: number
          id: string
          opened_units: number
          person_id: string
          quoted_price_cents: number | null
          realized_pnl_cents: number
          side: string
          surface: string | null
          units: number
          user_id: string
        }
        Insert: {
          balance_after_cents?: number | null
          closed_units?: number
          created_at?: string
          fill_price_cents: number
          gross_cents: number
          id?: string
          opened_units?: number
          person_id: string
          quoted_price_cents?: number | null
          realized_pnl_cents?: number
          side: string
          surface?: string | null
          units: number
          user_id: string
        }
        Update: {
          balance_after_cents?: number | null
          closed_units?: number
          created_at?: string
          fill_price_cents?: number
          gross_cents?: number
          id?: string
          opened_units?: number
          person_id?: string
          quoted_price_cents?: number | null
          realized_pnl_cents?: number
          side?: string
          surface?: string | null
          units?: number
          user_id?: string
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
          id: string
          is_admin: boolean
          username: string
          wallet_balance_cents: number
        }
        Insert: {
          avatar_url?: string | null
          buying_power_cents?: number
          created_at?: string
          display_name: string
          email: string
          id: string
          is_admin?: boolean
          username: string
          wallet_balance_cents?: number
        }
        Update: {
          avatar_url?: string | null
          buying_power_cents?: number
          created_at?: string
          display_name?: string
          email?: string
          id?: string
          is_admin?: boolean
          username?: string
          wallet_balance_cents?: number
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
          cost_usd: number | null
          first_call_at: string | null
          input_tokens: number | null
          last_call_at: string | null
          memory_calls: number | null
          narrative_calls: number | null
          output_tokens: number | null
          sentiment_calls: number | null
          tick_number: number | null
          unpriced_calls: number | null
        }
        Relationships: []
      }
      source_health: {
        Row: {
          avg_latency_ms_24h: number | null
          data_source_id: string | null
          display_name: string | null
          error_rate_24h: number | null
          errors_24h: number | null
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
      apply_engine_tick: { Args: { p_tick: Json }; Returns: Json }
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
      cents_to_dollars_text: { Args: { p_cents: number }; Returns: string }
      credit_paper_balance: {
        Args: { p_amount_cents: number; p_user_id: string }
        Returns: Json
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
      home_momentum: {
        Args: { p_points?: number; p_sample?: number; p_window?: string }
        Returns: {
          change: number
          person_id: string
          points: number
          sparkline: number[]
        }[]
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
      person_score_series: {
        Args: { p_person_id: string; p_points?: number; p_since?: string }
        Returns: {
          bucket_at: string
          open: number
          samples: number
          score: number
        }[]
      }
      place_order: {
        Args: {
          p_person_id: string
          p_quoted_price_cents?: number
          p_side: string
          p_surface?: string
          p_units: number
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
      shorting_enabled: { Args: never; Returns: boolean }
      snapshot_portfolios: {
        Args: { p_at: string; p_tick_number?: number }
        Returns: number
      }
      starting_balance_cents: { Args: never; Returns: number }
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
      username_available: { Args: { p_username: string }; Returns: boolean }
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

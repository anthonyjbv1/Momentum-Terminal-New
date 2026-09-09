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
      portfolio_history: {
        Row: {
          id: string
          recorded_at: string
          total_value_cents: number
          user_id: string
        }
        Insert: {
          id?: string
          recorded_at?: string
          total_value_cents: number
          user_id: string
        }
        Update: {
          id?: string
          recorded_at?: string
          total_value_cents?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_history_user_id_fkey"
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
          cost_basis_cents: number
          direction: string
          entry_score: number
          id: string
          is_open: boolean
          opened_at: string
          person_id: string
          shares: number
          user_id: string
        }
        Insert: {
          amount_cents: number
          closed_at?: string | null
          cost_basis_cents: number
          direction: string
          entry_score: number
          id?: string
          is_open?: boolean
          opened_at?: string
          person_id: string
          shares: number
          user_id: string
        }
        Update: {
          amount_cents?: number
          closed_at?: string | null
          cost_basis_cents?: number
          direction?: string
          entry_score?: number
          id?: string
          is_open?: boolean
          opened_at?: string
          person_id?: string
          shares?: number
          user_id?: string
        }
        Relationships: [
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
            foreignKeyName: "signals_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      source_snapshots: {
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
            foreignKeyName: "source_snapshots_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "data_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_snapshots_person_id_fkey"
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
      transactions: {
        Row: {
          amount_cents: number
          created_at: string
          id: string
          person_id: string | null
          type: string
          user_id: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          id?: string
          person_id?: string | null
          type: string
          user_id: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          id?: string
          person_id?: string | null
          type?: string
          user_id?: string
        }
        Relationships: [
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
      [_ in never]: never
    }
    Functions: {
      apply_engine_tick: { Args: { p_tick: Json }; Returns: Json }
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
      home_momentum: {
        Args: { p_points?: number; p_sample?: number; p_window?: string }
        Returns: {
          change: number
          person_id: string
          points: number
          sparkline: number[]
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
      placeholder_financial_mutation: {
        Args: { p_amount_cents: number }
        Returns: undefined
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
